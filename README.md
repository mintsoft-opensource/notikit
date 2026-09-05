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
apps/web            # Next.js 대시보드 + API + Swagger
packages/design     # 디자인 시스템(Tailwind v4 + shadcn/ui 토큰)
packages/sdk-core   # 공통 전송·API 클라이언트·타입
packages/sdk-web    # 브라우저 Web Push
packages/sdk-react  # React/Next hooks
sdks/android        # Kotlin/Java (Maven/JitPack)
sdks/swift          # Swift (SPM/CocoaPods)
sdks/flutter        # Dart (pub.dev)
sdks/react-native   # RN
mcp/                # 서버 내장 MCP (AI 개발 가속)
docs/plan/          # 기획 문서 세트
```

## 빠른 시작 (self-host)
```bash
cp .env.example .env      # 최소: NOTIKIT_ENCRYPTION_KEY(32자+), ADMIN_TOKEN 채우기
docker compose up -d      # web + worker + postgres + redis
open http://localhost:3000
```
- **web** 컨테이너가 기동 시 DB 마이그레이션을 자동 적용(`migrate.mjs`, 멱등) 후 서버를 시작한다.
- **worker** 컨테이너가 주기적으로 각 프로젝트의 큐 발송(`process-queue`)·저니 진행(`journeys/process`)·웹훅 재시도(`webhooks/retry`)를 처리한다. worker 가 없으면 `POST /api/v1/messages` 로 큐잉된 푸시는 발송되지 않는다.
- Firebase 자격증명이 없으면 **log-only 모드**로 동작(실제 발송 대신 로그만 기록, `status="logged"`).

## 개발
```bash
pnpm install
# 로컬 Postgres 준비 후 마이그레이션 적용:
export DATABASE_URL=postgres://notikit:notikit@localhost:5432/notikit
pnpm --filter @notikit/web db:migrate
pnpm --filter @notikit/web dev      # apps/web (Next.js, :3000)
# 별도 터미널에서 worker(선택):
ADMIN_TOKEN=... WORKER_BASE_URL=http://localhost:3000 pnpm --filter @notikit/web worker
```
> 로컬 개발은 `.env` 를 Compose 만 자동 로드하므로, `apps/web` 를 직접 띄울 땐 `DATABASE_URL`·`ADMIN_TOKEN`·`NOTIKIT_ENCRYPTION_KEY` 를 셸 환경에 넣어야 한다.

## 테스트
```bash
pnpm --filter @notikit/web test     # vitest (단위)
pnpm --filter @notikit/web e2e      # Playwright E2E (DB 필요)
```

## 문서
- 기획/아키텍처: [`docs/plan/`](docs/plan/) — 로드맵 문서. 각 기능의 **구현/계획** 상태는 [`docs/plan/01-features.md`](docs/plan/01-features.md) 참고.
- API: `/docs` (Swagger UI) · OpenAPI 스펙: `/api/openapi.json` — App SDK + Web Admin 전 엔드포인트 문서화.

## 라이선스
Apache-2.0
