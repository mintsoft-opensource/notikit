# 서버 아키텍처

> BYOC 전제: **단일 박스에서 돌되(고객 서버), 같은 코드로 스케일아웃.**
> (← [README](README.md) · 기능은 [01-features.md](01-features.md))
>
> ⚠️ **이 문서는 목표 아키텍처(로드맵)다.** 현재 실제 구현은 아래와 다르다:
> - API/대시보드는 **Next.js App Router 핸들러**(별도 Hono 머신 API 없음).
> - 큐는 **Postgres `push_logs` 레코드 + 원자적 클레임**(BullMQ/Redis 미사용; `docker-compose` 의 redis 는 예비).
> - worker 는 web 의 admin 엔드포인트를 폴링(`apps/web/worker.mjs`). realtime(Centrifugo)·Caddy 자동 TLS·자동 리텐션은 **미구현**.
> - 헬스체크는 `/api/health`(구현됨), `/ready` 는 없음. 마이그레이션은 Compose 의 `migrate` 서비스(`migrate.mjs`)가 web 시작 전에 자동 적용(구현됨).

## 1. 설계 원칙
1. **단일 이미지 · 12-factor** — 앱 stateless, 상태는 외부(Postgres/Redis/로그스토어). env로 1박스→클러스터
2. **컴포넌트 분리하되 기본은 한 컴포즈** — app/worker/realtime/log 논리 분리, 소규모는 한 박스
3. **데이터 3계층 분리** — OLTP / 큐 / 로그(대량)
4. **프로바이더 추상화** — FCM/APNs/VAPID/WebSocket 어댑터
5. **⭐ 컨트롤-플레인 친화 5원칙** (BYOC 이식 서비스를 공짜로 만들기 위해)
   - ① 모든 설정 env(하드코딩 0) ② `/health` `/ready` ③ 부팅 시 자동 마이그레이션 ④ web/worker 단일이미지+command 분리 ⑤ 구조화 로그(JSON)+메트릭

## 2. 컴포넌트 (논리)
```
                ┌──────── Caddy (자동 TLS/역프록시) ────────┐
 SDK/대시보드 → │  대시보드(Next.js)   머신 API(Hono)        │
                │  Realtime(Centrifugo) ← webview/electron/web 상시연결
                └────────────────────────────────────────────┘
                     │                        │
              [OLTP: Postgres]         [Worker(s)] ── FCM/APNs/VAPID 전송
          project/app/device/user/topic       │
              (project_id + RLS)        [로그/이벤트 스토어]
                     │                  파티션 Postgres → ClickHouse (리텐션 강제)
              [Object storage] 볼륨/S3
```

## 3. UI vs 머신 API 분리 (핵심 결정)
| 표면 | 무엇 | 스택 |
|---|---|---|
| **관리 대시보드** | React UI + admin BFF | **Next.js**(App Router) + shadcn/ui |
| **머신 API** | SDK 엔드포인트·수집·웹훅·MCP | **전용 Hono 서비스**(경량·빠름·어디서나) |

> Next.js Route Handlers를 머신 API 주력으로 쓰지 않음(서버리스 타임아웃·콜드스타트·커넥션 제한). 대시보드 BFF엔 OK.

## 4. 배포 프로파일 (S/M/L) — 같은 이미지, env 전환
| 프로파일 | 대상 | 구성 | 로그 |
|---|---|---|---|
| **Small** | ~수만 디바이스 | 한 박스 compose: app+worker+postgres+redis+caddy | 파티션 Postgres + purge(7~30일) |
| **Medium** | 수십만~백만 | **외부 관리형 DB** + 워커 2~3 + Centrifugo 분리 | ClickHouse/Timescale |
| **Large** | 백만+ / AI 대량 | 워커 오토스케일 + DB 읽기복제 + ClickHouse 클러스터 + LB | ClickHouse 클러스터 |

## 5. 데이터 계층 (분리 필수)
| 계층 | 저장소 | 이유 |
|---|---|---|
| OLTP 코어 | **Postgres**(RLS, `project_id`) | 저지연 조회/발송 hot path |
| 큐/캐시 | **Redis**(BullMQ) | fan-out, rate limit, idempotency |
| 로그/이벤트 | **파티션 Postgres → ClickHouse** | 대량 append, 리텐션 purge, 분석 |
| 오브젝트 | 볼륨/S3 | 리치 푸시 이미지 |

**⚠️ 디바이스 테이블과 푸시 로그를 같은 DB에 두면 안 되는 이유**(AI 볼륨 3~5배 시 치명):
쓰기 비대칭(로그가 hot path I/O 잠식) · OLTP↔OLAP 상극 · 로그 블로트로 백업/복구 악화 · 리텐션/컴플라이언스 불일치 · 독립 확장 불가 · **BYOC 단일박스는 로그가 디스크 채워 서비스 다운**.
→ **로그 저장소 분리 + 강제 리텐션 purge**.

**DB 선택:** vanilla **PostgreSQL** 기준(Aurora/RDS/Neon/Cloud SQL/자체 다 호환). Aurora PostgreSQL(Serverless v2 오토스케일)은 AWS 고객용 좋은 옵션이나 **Aurora 전용 기능 종속 금지**(락인 회피). ORM=**Drizzle**(서버리스 경량, raw SQL 자유) 또는 Prisma. 서버리스면 **커넥션 풀링 필수**(PgBouncer/Neon 풀러).

## 6. 멀티테넌시
- **Org/Workspace → Project → App(플랫폼)** 계층. 한 설치 = 여러 프로젝트(에이전시 대행)
- `project_id` + **RLS** 격리 · **환경 분리(dev/staging/prod)** 프로젝트별 키
- Firebase 자격증명 **AES-256-GCM** 암호화(키는 env/KMS)

## 7. 프로바이더 / 채널 추상화
```
messages.send() → ChannelRouter
   ├─ FCMAdapter (android/ios/web-fcm)   ├─ APNsAdapter(옵션)
   ├─ VAPIDAdapter (web push)            ├─ RealtimeAdapter(webview/electron/web WS)
   └─ KakaoAdapter (알림톡/친구톡 폴백)
  공통: 재시도+백오프, DLQ, idempotency, 무효토큰 자동정리
```

## 8. API 설계
- **OpenAPI-first** — 단일 스펙에서 **SDK · 문서 · MCP 도구 · llms.txt** 파생(드리프트 0)
- **버전 고정** `/api/v1` (SDK 의존)
- **멀티표면 인증**: api-key/secret(v1), X-Project-Id/X-Api-Key(spring 호환), admin 세션, MCP 인증
- **수집 ≠ 전송 분리**: API는 받으면 **큐에 넣고 즉시 ack** → 워커가 fan-out (API 블로킹 X)
- 테넌트 격리(RLS) · idempotency · rate limit · Zod 검증

## 9. SDK 매트릭스 (계층형)
```
@mintapp-push/core       # 전송·API 클라이언트·타입 (공통)
├─ web                   # 브라우저 Web Push
├─ react                 # web 위 hooks (Next 포함)
├─ webview   ⭐           # WebView 감지 → 네이티브 브리지 (직접 Web Push 대신)
├─ android / ios         # 네이티브 FCM/APNs + WebView 브리지 호스트
├─ flutter / electron    # electron = WS 상시연결 + 네이티브 Notification
└─ capacitor / cordova 플러그인   # 하이브리드 앱 원클릭
```
+ **서버 내장 MCP**: `create_project` · `register_app` · **`get_integration_snippet`**(실제 키 박힌 코드) · **`send_test_push`** · `get_api_schema`. 셀프호스트 인스턴스가 자기 MCP 엔드포인트 노출.

## 10. 딥링크 / 지역 / 개인화
- **딥링크**: payload `deep_link` + 앱쪽 Universal Links(AASA)/App Links(assetlinks). 지연/어트리뷰션만 Branch/AppsFlyer
- **지역**: GeoIP(MaxMind, 서버 — LB뒤라 `X-Forwarded-For`) + locale/timezone(SDK 등록 시 전송)
- **개인화**: 템플릿 변수치환, 수신자별 개별 렌더링(토픽 브로드캐스트 제외)

## 11. 웹훅
아웃바운드: **HMAC-SHA256 서명** + **큐 비동기** + 지수 백오프 재시도 + **DLQ** + 멱등(event id) + 전송로그/수동재전송. 대량은 필터링/배치/스트리밍. → **Svix(OSS, 셀프호스트) 재사용**.

## 12. 운영 (설치형 의뢰 대응)
- 원클릭 설치(compose/Helm) + 프로파일 선택 · 부팅시 마이그레이션 · `/api/health`
- **백업/복구 내장**(pg_dump 스케줄 + 볼륨 스냅샷) · 업그레이드(버전태그·롤백)
- 모니터링(구조화 로그 + Prometheus, 옵션 agent 원격수집)
- **리텐션 자동 purge**(로그 디스크 보호 — BYOC 최다 사고)

## 13. 보안
크레덴셜 AES-GCM(키 env/KMS) · agent **아웃바운드** · RLS 격리 · API키 스코프/로테이션 · TLS 자동 · 감사로그.
