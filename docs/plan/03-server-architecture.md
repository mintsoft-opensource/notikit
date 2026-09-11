# 서버 아키텍처

> 전제: **고객사 박스 한 대에서 돌되, 같은 이미지로 스케일아웃.**
> (← [README](README.md) · 기능은 [01-features.md](01-features.md) · 배포는 [../DISTRIBUTION.md](../DISTRIBUTION.md))
>
> 개정일: 2026-09-11
> **이 문서는 현재 구현을 기술한다.** 목표만 적고 "실제는 다름" 주석을 다는 방식은 폐기했다 —
> 그 형태는 읽는 사람이 무엇을 믿어야 할지 모르게 만든다. 미구현은 §14에 따로 모았다.

## 1. 설계 원칙
1. **단일 이미지 · 12-factor** — 앱 stateless, 상태는 외부(Postgres). env로 1박스→클러스터
2. **한 compose 안에서 역할 분리** — web/worker/updater는 같은 이미지, `command`만 다름
3. **프로바이더 추상화** — FCM/카카오 어댑터
4. **설정은 전부 env** — 부팅 시 필수값 검증(없으면 시작 거부). web 은 `instrumentation.ts`
   가 `register()` 에서 확인하고, 부족하면 프로세스를 끊는다 — 설정이 깨진 인스턴스가
   기동해 "성공한 업데이트"로 기록되는 것을 막는다
5. **권한 최소화** — Docker 소켓은 포트 없는 사이드카 하나만 쥔다

## 2. 컴포넌트 (실제)

```
                    ┌─────────────────────────────┐
  SDK / 브라우저 ──▶ │  web (Next.js 16 App Router) │
                    │  · 콘솔 UI (서버 컴포넌트)    │
                    │  · /api/v1/*   SDK API        │
                    │  · /api/admin/* 콘솔 API      │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Postgres          │  OLTP + 큐 + 로그 (단일 DB)
                    │   · 코어 테이블      │
                    │   · push_logs (큐)  │
                    │   · update_jobs     │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
  ┌─────▼─────┐        ┌───────▼────────┐    ┌────────▼────────┐
  │  worker   │        │    updater     │    │     redis       │
  │ web admin │        │ Docker 소켓 보유 │    │  ⚠️ 현재 미사용  │
  │ 폴링       │        │ 포트 없음       │    │  (예비)          │
  └───────────┘        └────────────────┘    └─────────────────┘
                               │
                          FCM / 카카오
```

**API 표면이 하나다.** 이전 기획은 콘솔(Next.js)과 머신 API(Hono)를 분리했다. 실제로는 **Next.js Route Handler 하나**로 둘 다 처리한다.

분리를 안 한 이유: 분리의 근거가 서버리스 타임아웃·콜드스타트였는데, **우리는 서버리스에 배포하지 않는다.** 고객사 박스의 장수명 Node 프로세스다. 그 환경에서 서비스를 둘로 쪼개면 이미지·배포·인증이 두 벌이 될 뿐 얻는 게 없다.

## 3. 큐 — Postgres 기반

BullMQ/Redis를 쓰지 않는다. **`push_logs` 레코드 + 원자적 클레임**이다.

`src/lib/push-processor.ts` — **조건부 UPDATE + RETURNING**으로 클레임한다.

```
UPDATE push_logs
   SET status='processing', locked_at=now(), lock_token=<uuid>
 WHERE id = $1
   AND ( status='queued'
      OR (status='scheduled'  AND scheduled_at <= now())
      OR (status='processing' AND (locked_at IS NULL OR locked_at < now()-STALE_MS)) )
RETURNING *
```

빈 결과 = 다른 워커가 먼저 집었다는 뜻이고, 그때는 조용히 물러난다. 행 잠금이 아니라
**상태 전이 자체가 상호배제**라 커넥션을 붙들고 있을 필요가 없다.

세 번째 OR 절이 중요하다. 워커가 처리 도중 죽으면 그 행은 `processing`에 영원히 남는데,
`locked_at`이 `STALE_MS`보다 오래됐으면 **다른 워커가 회수한다.** 이게 없으면 워커 한 번
크래시에 그 발송이 영구히 묶인다.

`lock_token`은 완료 시점에 같이 검사한다 — 회수된 뒤 돌아온 원래 워커가 남의 작업을
덮어쓰지 못하게.

**왜 Redis를 안 쓰나:** 고객사 박스에 상태 저장소가 하나 더 늘면 백업 대상도, 장애 지점도, 설명할 것도 하나 더 는다. 온프렘에서 컴포넌트 수는 그대로 지원 비용이다. Postgres가 이미 있고 조건부 UPDATE로 충분하다.

**한계:** 초당 수만 건 fan-out에서는 Postgres 큐가 병목이 된다. 그 구간에 도달하면 교체한다(§14).

**worker:** `apps/web/worker.mjs` — web의 admin 엔드포인트를 폴링하는 얇은 프로세스. 별도 빌드가 없다.

⚠️ 큐·저니·웹훅 처리는 **매 tick(기본 10초)마다 전 프로젝트를 순차 호출**하며 분산이 없다.
`staggerMinute()`는 야간 토큰 스윕(`TOKEN_CHECK_*`) 전용이지 큐 fan-out과 무관하다.
프로젝트 수가 늘면 한 tick 안에 전부 처리하지 못하는 지점이 온다.

## 4. 데이터 — 현재는 단일 Postgres

| 계층 | 현재 | 비고 |
|---|---|---|
| OLTP 코어 | Postgres | org/project/device/user/topic |
| 큐 | Postgres (`push_logs`) | 별도 저장소 없음 |
| 로그/이벤트 | Postgres (`push_logs` 겸용) | ⚠️ 아래 |
| 오브젝트 | 없음 | 리치 푸시 미구현 |

### ⚠️ 로그와 OLTP가 같은 DB에 있다

이건 **의도된 타협이고, 알려진 부채다.**

문제: 푸시 로그는 append가 많고 hot path I/O를 잠식한다. 로그가 커지면 백업·복구 시간이 같이 늘고, 단일 박스에서는 **로그가 디스크를 채워 서비스가 멈춘다** — 온프렘 최다 사고 유형이다.

지금 이렇게 둔 이유: 컴포넌트 하나를 줄이는 값이 현재 볼륨에서 더 크다.

### `push_logs` 리텐션 purge

로그가 코어 테이블과 같은 DB에 있으므로, 무한히 자라면 디스크가 차고 **로그 때문에
푸시 전체가 죽는다.** 고객사 박스에는 우리가 들어갈 수 없어 사고 후 대응이 불가능하다.

`LOG_RETENTION_DAYS`(일)를 설정하면 워커가 야간 스윕 창에서 프로젝트별로 배치 삭제한다.

- **종료 상태만 지운다** — `completed`/`failed`/`logged`. `queued`·`scheduled`·`processing`은
  워커가 아직 손댈 수 있어서 지우면 예약 발송이 조용히 사라진다
- 5,000행 배치, 호출당 최대 20배치. 큰 테이블에서 단일 DELETE는 락과 WAL을 오래 잡는다.
  남으면 `done:false`로 돌려주고 다음 창에서 이어 간다
- `push_clicks`는 FK cascade로 함께 지워진다
- 인덱스는 기존 `push_logs_project_idx (project_id, created_at)`를 그대로 쓴다

⚠️ **미설정이면 아무것도 지우지 않는다.** 보존 기간은 고객이 정할 일이라 기본값을
강제하지 않지만, 그 상태로 두면 원래 문제로 돌아간다. 인수인계 체크리스트 항목이다.
`GET`으로 현재 설정과 삭제 대상 건수를 확인할 수 있다.

**DB 선택:** vanilla PostgreSQL 기준. ORM은 **Drizzle**, 마이그레이션은 `drizzle/*.sql` + 저널. 마이그레이션은 compose의 `migrate` 서비스가 web 시작 **전에** 적용한다(구버전 코드가 새 스키마를 만나는 창을 없앤다).

## 5. 멀티테넌시
- **Org → Project** 계층. 한 설치 = 여러 프로젝트
- `project_id` 스코프 격리 · 프로젝트별 Firebase 자격증명 **AES-256-GCM** 암호화(키는 `NOTIKIT_ENCRYPTION_KEY`)
- 역할: owner / admin / viewer

### 인스턴스 운영자 ≠ 조직 소유자

멀티테넌트에서 `role === "owner"`는 **한 고객 조직의** 소유자다. 인스턴스 전체의 운영자가 아니다.

업데이트·지원 번들처럼 **설치 전체**에 영향을 주는 기능을 `owner`로 열면, 어느 고객이든 인스턴스를 재시작시킬 수 있다. `isInstanceOperator()`는 superadmin이거나 **부트스트랩 조직**(가장 먼저 생성된 org)의 owner만 통과시킨다.

## 6. 인증 표면

| 표면 | 인증 | 용도 |
|---|---|---|
| `/api/v1/*` (공개) | `api-key` | 등록·식별·구독 — 클라이언트 안전 |
| `POST /api/v1/messages` | `api-key` + `api-secret` | **서버 전용** 발송 |
| `/api/admin/*` | 세션 쿠키 또는 `x-admin-token` | 콘솔 / 프로그램적 |

하위 경로는 별개다 — `POST /api/v1/messages/click`은 **api-key만** 요구한다(클라이언트가 호출하므로).
표의 행이 `/api/v1/messages/*` 전체를 덮는 것으로 읽으면 안 된다.

`identity_hash`(HMAC)로 external_id 바인딩을 검증한다. 없으면 아무나 남의 유저 ID를 주장할 수 있다.

CSRF: 쿠키 세션 mutation은 Origin 검사. 바디 상한 32KB. 로그인은 이메일당 분당 10회.

## 7. 프로바이더 / 채널

```
messages.send() → ChannelRouter
   ├─ FCMAdapter   (android/ios/web)
   └─ KakaoAdapter (알림톡 폴백)
  공통: 재시도, 무효토큰 자동정리(unregistered 응답 기반)
```

**log-only 모드:** Firebase 미설정 프로젝트는 실제 발송 없이 로그만 남긴다. 데모·개발에서 자격증명 없이 전체 플로우를 돌리기 위한 것이다.

## 8. API 설계
- **OpenAPI-first** — 단일 스펙에서 문서·MCP 파생. 콘솔이 Redoc으로 임베드 렌더
- **버전 고정** `/api/v1`
- **수집 ≠ 전송 분리** — 받으면 `push_logs`에 넣고 즉시 ack, worker가 fan-out
- Zod 검증 · rate limit · 표준 응답 봉투(`{success, data, error}`)

## 9. SDK 매트릭스

```
packages/
  sdk-core          # API 클라이언트·타입 (공통)
  sdk-web           # 브라우저 Web Push
  sdk-react         # web 위 hooks
  sdk-react-native
sdks/
  android (Kotlin) / swift / flutter
```

+ **MCP 5 tools** — 고객사 인스턴스가 자기 MCP 엔드포인트를 노출한다.

## 10. 배포 (고객사)

`docker-compose.prod.yml` — 개발용과 다른 점은 하나: **소스에서 빌드하지 않는다.**

고객사 박스에는 소스가 없고, 있어도 거기서 빌드하면 업데이트에 수 분과 메모리가 들며 빌드가 깨지면 설치본이 망가진 채로 남는다.

돌고 있는 버전은 `.notikit-image.env` **한 줄**에 있고 업데이터가 그 줄을 바꾼다. compose 파일 본문은 건드리지 않는다 — 고객이 손댄 설정과 충돌하기 때문이다.

이미지는 **다이제스트로 고정**한다(`@sha256:…`). 태그는 나중에 다른 이미지를 가리키게 바뀔 수 있다.

## 11. 국제화
next-intl, **25개 로케일**. 병합 순서 `ko → en → 요청 로케일`.

ko를 맨 아래 두는 이유: 한국어로 먼저 개발하므로 ko에만 있는 키가 생기고, 그런 키는 비어서 깨지지 않고 한국어로 뜬다. en을 그 위에 두는 이유: 아직 번역 안 된 로케일의 관리자에게 한국어보다 영어가 낫다.

## 12. 보안
자격증명 AES-GCM · 토큰 비교는 상수 시간 · 디바이스 목록에 토큰 원문 미노출 · 지원 번들은 **값 없이 설정 유무만** · 업데이터만 Docker 소켓 보유 · 폐쇄망 번들 체크섬 강제.

## 13. 테스트
e2e 65 (Playwright) · 단위 57 (Vitest, `pnpm -r test` 전체 — apps/web 25 + sdk-core 11 + sdk-web 14 + sdk-react-native 7).
`packages/sdk-react`는 test 스크립트만 있고 테스트 파일이 없다.

⚠️ `playwright.config.ts`가 포트 **3100** 고정이다. 다른 프로젝트가 그 포트를 쓰고 있으면 `reuseExistingServer`가 헛다리를 짚어 `EADDRINUSE`로 전부 실패한다. `E2E_PORT`로 우회 가능하나 기본값을 덜 흔한 값으로 바꾸는 편이 낫다.

## 14. 미구현 / 부채

| 항목 | 영향 | 우선순위 |
|---|---|---|
| **graceful shutdown (SIGTERM)** | 업데이트 중 발송 유실 가능. 무인 업데이트의 전제 조건 | **높음** |
| **rate limit이 인메모리** | 다중 인스턴스로 늘리면 **한도가 인스턴스 수만큼 곱해진다.** 스케일아웃 전 Redis 기반으로 교체 필수 | **높음** |
| 로그 저장소 미분리 | 볼륨 증가 시 hot path 잠식 (purge가 생긴 뒤에도 남는 문제) | 중 |
| Redis 미사용 | compose에 떠 있으나 코드가 안 씀. 켜 두는 값이 없으면 빼는 편이 정직 | 낮음 |
| realtime(Centrifugo) | 상시연결 채널 없음 | 낮음 |
| 자동 TLS(Caddy) | 현재 역프록시는 고객 몫 | 낮음 |
| 웹훅 DLQ / idempotency | 재시도는 있으나 DLQ 없음 | 중 |

**rate limit 이 스케일아웃의 실질 차단선이다.**

인스턴스를 2대로 늘리면 rate limit이 조용히 2배로 느슨해진다. 발송 한도만이 아니라
**로그인 시도 허용치도 같이 2배**가 된다(`login:${email}`이 같은 인메모리 리미터를 쓴다).
장애가 아니라 **보안 문제**로 나타나기 때문에 늦게 발견된다.
