# Notikit

> **오픈소스 · 셀프호스트 가능 · 유저 중심(user-centric) 푸시 알림 툴킷.**
> FCM 위에 **사용자·계정 identity 레이어**를 얹고, 멀티플랫폼 SDK + 관리 대시보드를 제공.

`notikit.dev` · Apache-2.0 · 운영: MintSoft

## 무엇인가
- **유저 중심 푸시**: 토큰이 아니라 "유저 X"에게 발송, 계정↔다중기기 연결
- **멀티테넌트**: 프로젝트별 Firebase 자격증명 격리·암호화 (에이전시/SI 대행)
- **멀티플랫폼 SDK**: Web(JS/React) · WebView · Android(Kotlin/Java) · Swift · Flutter · React Native
- **셀프호스트**: `docker compose up` 한 방, 데이터 주권

## 모노레포 구조
```
apps/web                    # Next.js 대시보드 + API + Swagger (+ worker.mjs, migrate.mjs)
packages/design             # 디자인 시스템(Tailwind v4 + shadcn/ui 토큰)
packages/sdk-core           # 공통 전송·API 클라이언트·타입
packages/sdk-web            # 브라우저 Web Push
packages/sdk-react          # React/Next hooks
packages/sdk-react-native   # React Native
sdks/android                # Kotlin/Java (Maven/JitPack)
sdks/swift                  # Swift (SPM/CocoaPods)
sdks/flutter                # Dart (pub.dev)
mcp/                        # 독립 실행 MCP 서버 (stdio; AI 개발 가속)
docs/plan/                  # 기획 문서 세트
```

## 빠른 시작 (로컬 평가)
```bash
cp .env.example .env      # 최소: NOTIKIT_ENCRYPTION_KEY(32자+), ADMIN_TOKEN, POSTGRES_PASSWORD
docker compose up -d --build   # migrate + web + worker + postgres + redis
docker compose ps              # web/postgres/redis 가 healthy 여야 한다
open http://localhost:3000
```
```bash
docker compose logs -f web worker   # 로그
docker compose run --rm migrate     # 마이그레이션만 다시
docker compose down                 # 중지 (데이터 볼륨은 남는다)
```

> ⚠️ **`docker-compose.yml` 은 개발·로컬 평가용이다.** 소스에서 빌드하고, 편의를 위해
> Postgres·Redis 포트를 호스트(`127.0.0.1` 한정)에 내보낸다.
> **실제 설치(고객사·VPS)는 `docker-compose.prod.yml`** — 레지스트리 이미지를 쓰고 DB 포트를
> 열지 않으며 콘솔도 기본이 루프백이다(`NOTIKIT_BIND`). 자세한 내용은 `apps/web/docs/08-ops.md`.

- **migrate** 서비스가 먼저 DB 마이그레이션을 적용(`migrate.mjs`, 멱등)하고, **web** 은 그 성공 후 시작한다. `web` 은 `/api/ready`(DB 연결까지 확인) 헬스체크가 통과해야 healthy 가 되고, **worker** 는 그 뒤에 뜬다.
- **worker** 컨테이너가 주기적으로 각 프로젝트의 큐 발송(`process-queue`)·저니 진행(`journeys/process`)·웹훅 재시도(`webhooks/retry`)를 처리한다. worker 없이도 해당 admin 엔드포인트를 직접(cron 등) 호출하면 발송된다. 다만 worker 가 없으면 큐잉만 되고 자동 발송은 되지 않는다.
- Firebase 자격증명이 없으면 **log-only 모드**로 동작(실제 발송 대신 로그만 기록, `status="logged"`).

## 개발
```bash
pnpm install
# 로컬 Postgres 준비 후 마이그레이션 적용:
export DATABASE_URL=postgres://notikit:notikit@localhost:5432/notikit
pnpm --filter @notikit/web db:migrate
pnpm --filter @notikit/web dev      # apps/web (Next.js, :3000)

# 또는 DB/Redis 만 컨테이너로 두고 웹은 손으로 (compose 콘솔 3000 과 겹치지 않게 3001):
docker compose up -d postgres redis
cd apps/web && npx next start -p 3001

# 포트: 3000 compose 콘솔 / 3001 수동 실행 / 3100 e2e(notikit_e2e DB) — 동시에 띄워도 된다
# 별도 터미널에서 worker(선택):
ADMIN_TOKEN=... WORKER_BASE_URL=http://localhost:3000 pnpm --filter @notikit/web worker
```
> 로컬 개발은 `.env` 를 Compose 만 자동 로드하므로, `apps/web` 를 직접 띄울 땐 `DATABASE_URL`·`ADMIN_TOKEN`·`NOTIKIT_ENCRYPTION_KEY` 를 셸 환경에 넣어야 한다.

## 테스트
```bash
pnpm --filter @notikit/web test     # vitest (단위)
pnpm --filter @notikit/web e2e      # Playwright E2E (DB 필요)
```

## 콘솔 로그인
- 관리 콘솔(`/dashboard` 등 `(app)` 그룹)은 **이메일/비밀번호 계정 로그인**으로 보호된다(세션은 httpOnly 서명 쿠키, scrypt 해시).
- 최초 접속 시 `/login` 에서 **최초 관리자(owner) 계정을 부트스트랩 등록**한다(관리자 0명일 때만).
- 프로그램적 접근(E2E/curl/worker)은 `x-admin-token`(= `ADMIN_TOKEN`) 으로 superadmin 인증 가능(하위호환).
- 역할: `owner`/`admin` 은 쓰기, `viewer` 는 읽기 전용. 프로젝트는 org 단위로 격리된다.

## 보안 · 배포 하드닝 (프로덕션)
- **`BOOTSTRAP_TOKEN` 설정 권장**: 미설정 상태의 빈 설치는 먼저 접근한 사람이 최초 관리자를 선점할 수 있다. 공개 배포 전 설정하면 최초 등록에 `x-bootstrap-token` 헤더가 필요해진다.
- **TLS**: 리버스 프록시에서 TLS 종료 시 `APP_ORIGIN=https://your-host` 지정(CSRF 정확 대조). 쿠키 `Secure` 는 프로덕션 기본 활성(로컬 http 는 `COOKIE_INSECURE=true`).
- **시크릿**: `NOTIKIT_ENCRYPTION_KEY`(암호화)·`SESSION_SECRET`(세션 서명, 미설정 시 암호화 키 대체)·`ADMIN_TOKEN` 은 강한 랜덤값으로.
- **다중 인스턴스**: rate limit/큐는 현재 **단일 인스턴스** 기준(인메모리). 수평 확장 시 Redis 기반 리미터/큐로 교체(`.env.example` 참고).
- 전 변경 API 는 same-origin `Origin` 검증(CSRF), 요청 본문 32KB 상한(스트리밍), 로그인 계정별 rate limit + scrypt 동시성 상한을 적용한다.

## 문서
- 기획/아키텍처: [`docs/plan/`](docs/plan/) — 로드맵 문서. 각 기능의 **구현/계획** 상태는 [`docs/plan/01-features.md`](docs/plan/01-features.md) 참고.
- API: `/docs` (Swagger UI) · OpenAPI 스펙: `/api/openapi.json` — App SDK + Web Admin 전 엔드포인트 문서화.

## 라이선스
Apache-2.0
