---
title: 운영
---

# 운영

## 어느 compose 파일을 쓰는가

| 파일 | 용도 | 특징 |
|---|---|---|
| `docker-compose.yml` | **개발·로컬 평가 전용** | 소스에서 빌드. postgres/redis 를 같이 띄우고 5432·6379 를 `127.0.0.1` 에만 노출 |
| `docker-compose.prod.yml` | **실제 설치(고객사·VPS)** | 레지스트리 이미지 사용. DB 포트를 열지 않고, 콘솔도 기본은 루프백(`NOTIKIT_BIND`) |

실제 서버에 `docker-compose.yml` 을 그대로 올리지 마세요. 개발 편의를 위해 DB 포트를 호스트에
내보내고 소스 빌드를 전제합니다.

`docker-compose.prod.yml` 은 **`--env-file` 두 개**와 함께 씁니다. compose 는 프로젝트 디렉터리의
`.env` 하나만 치환(`${NOTIKIT_IMAGE}`)에 쓰므로, 업데이터가 갱신하는 `.notikit-image.env` 는
명시하지 않으면 읽히지 않습니다.

```bash
export COMPOSE_FILE=docker-compose.prod.yml
export COMPOSE_ENV_FILES=.env,.notikit-image.env
docker compose up -d
# 또는: docker compose -f docker-compose.prod.yml \
#         --env-file .env --env-file .notikit-image.env up -d
```

`NOTIKIT_IMAGE` 와 `NOTIKIT_UPDATER_IMAGE` 에는 **기본값이 없습니다.** 비어 있으면 compose 가
기동을 거부합니다 — 업데이터를 web 이미지로 내려앉히면 Next 서버가 Docker 소켓을 쥔 채 뜨고
업데이트 작업은 아무도 집어가지 않기 때문입니다.

두 파일 모두 `POSTGRES_PASSWORD` 에 **기본값이 없습니다**. 비어 있으면 compose 가 기동을
거부합니다 — compose 파일에 박힌 비밀번호는 아무도 바꾸지 않기 때문입니다.

두 파일 모두 DB 를 쓰는 컨테이너(`migrate`·`web`, 운영용은 `updater` 까지)에 `DATABASE_URL` 을
`postgres://…@postgres:5432/…` 로 **덮어** 넣고, `web` 에는 `REDIS_URL=redis://redis:6379` 를
덮어 넣습니다. `.env` 의 `localhost` 값은 호스트에서 직접 돌릴 때만 쓰입니다(컨테이너 안의
localhost 는 자기 자신입니다). 운영용 파일에서 관리형 Postgres·Redis 를 쓰려면 `.env` 에
따로 적습니다 — 업데이터가 web 을 다시 띄울 때도 같은 `.env` 로 치환하므로 그대로 유지됩니다:

```bash
NOTIKIT_DATABASE_URL=postgres://user:pass@db.internal:5432/notikit
NOTIKIT_REDIS_URL=redis://cache.internal:6379
```

운영용 파일은 `.env` 에 **`NOTIKIT_HOST_DIR`**(compose 파일이 있는 디렉터리의 호스트 절대 경로)를
적어 두세요. 업데이터는 이 디렉터리를 **같은 경로**로 마운트해서 compose 를 부릅니다 — 다른
경로(예전의 `/project`)로 마운트하면 `./bundles` 같은 상대 바인드가 그 경로로 풀려 호스트
데몬에 넘어가고, 업데이트 뒤의 `web` 이 빈 디렉터리를 봅니다. 비워 두면 compose 를 실행한 셸의
`$PWD` 를 쓰며, 둘 다 비면 업데이터가 compose 파일을 찾지 못해 기동을 거부합니다.

## 명령어

```bash
cp .env.example .env         # NOTIKIT_ENCRYPTION_KEY, ADMIN_TOKEN, POSTGRES_PASSWORD 채우기

docker compose up -d --build # 기동 (migrate → web → worker 순서로 게이트됨)
docker compose ps            # 상태 — web/postgres/redis 는 healthy 가 떠야 정상
docker compose logs -f web worker
docker compose logs worker   # 워커만
docker compose down          # 중지 (볼륨=데이터는 남는다)
docker compose restart worker
```

콘솔은 <http://localhost:3000> 입니다.

### 마이그레이션

`migrate` 서비스가 기동 때마다 먼저 돌고(멱등), **성공해야** web 이 뜹니다. 손으로 다시 돌리려면:

```bash
docker compose run --rm migrate          # 스키마만 적용
docker compose up -d --force-recreate web  # 적용 후 web 교체
```

### 의존성만 띄우고 웹은 손으로 (개발)

콘솔을 직접 고쳐 가며 볼 때는 DB/Redis 만 컨테이너로 두고 웹은 호스트에서 띄웁니다.
compose 의 콘솔(3000)과 포트가 겹치지 않게 3001 을 씁니다.

```bash
docker compose up -d postgres redis      # 의존성만
docker compose stop web worker           # 컨테이너 웹이 떠 있었다면 내린다

cd apps/web
npm run build && npx next start -p 3001  # 또는 npm run dev
```

`.env` 의 `DATABASE_URL`·`REDIS_URL` 은 `localhost` 를 가리키므로 그대로 붙습니다
(컨테이너 안에서만 `postgres`·`redis` 호스트명으로 덮입니다).

포트 정리 — **3000** compose 콘솔 / **3001** 수동 실행 / **3100** e2e(`playwright.config.ts`,
`notikit_e2e` DB). 셋은 겹치지 않으므로 동시에 띄워도 됩니다.

### 헬스체크

- `GET /api/health` — liveness. 프로세스가 살아 있는가. DB 가 죽어도 200
- `GET /api/ready` — readiness. DB 에 붙고 스키마가 맞는가. **compose 의 healthcheck 는 이쪽**
  - 스키마는 `drizzle.__drizzle_migrations` 에 적용된 마지막 마이그레이션이 이미지에 실린
    `drizzle/meta/_journal.json` 의 마지막 항목에 닿았는지로 봅니다. 뒤처져 있으면
    `503 {"reason":"schema behind","applied":…,"expected":…}` — migrate 가 실패했는데 web 만 뜬 상태입니다
  - DB 가 저널보다 앞서 있는 것은 통과입니다(마이그레이션 없는 릴리스를 되돌린 직후 등)

`web` 이 healthy 가 되어야 `worker` 가 시작합니다. 워커가 DB 도 못 붙은 웹을 폴링하며
기동 로그를 실패 경고로 채우지 않게 하려는 것입니다.

> Next standalone 의 `server.js` 는 `HOSTNAME` 에 바인드합니다. Docker 가 그 값을 컨테이너
> ID 로 채우면 eth0 에만 붙고 루프백이 열리지 않아, 컨테이너 안에서 도는 healthcheck 가
> 전부 실패합니다. Dockerfile 에서 `HOSTNAME=0.0.0.0` 으로 고정해 두었습니다.

발송은 큐를 거칩니다. **발송 큐** 화면에서 대기·처리 중·예약 건과 최장 대기 시간을 볼 수 있습니다.

- 대기가 계속 쌓이고 최장 대기 시간이 자란다 → 워커가 멈췄거나 Firebase 설정이 없습니다
- 예약 건수만 많다 → 정상입니다. 예약 시각이 되면 처리됩니다
- 워커 없이 수동으로 밀어야 한다면 큐 화면의 "큐 처리" 버튼을 쓰세요

워커는 프로젝트 목록을 커서로 끝까지 읽어 모든 프로젝트를 처리합니다. 큐 처리·저니 진행·웹훅 재시도·토큰 점검을 담당합니다.

야간 작업(로그 리텐션 purge·죽은 토큰 점검)은 프로젝트마다 하루 한 번입니다. `TOKEN_CHECK_HOUR_UTC`
시에 프로젝트별로 0-59분 흩어진 시각이 **지난 뒤 첫 tick** 에 돌고, 끝나지 않았으면(purge 가
`done:false`, 토큰 점검이 partial, 요청 실패) 다음 tick 이 이어받습니다. 끝내면 다음 날 그 시각까지
쉽니다. 앞선 tick 이 길어져도 그날을 건너뛰지 않습니다. 워커를 재기동하면 그날 한 번 더 돌 수
있지만, purge 는 멱등이고 토큰 점검은 서버가 `TOKEN_CHECK_MIN_INTERVAL_HOURS` 로 거릅니다.

## 위치 데이터 적재

```bash
cd apps/web
npm run db:geo              # 국가 + IPv4 + IPv6
npm run db:geo -- --dry-run # 받아서 검증만
npm run db:geo -- --no-ipv6 # IPv6 생략
```

적재 이력은 **시스템** 화면에서 확인합니다. 현재 적재량도 함께 보여주므로, 적재 후 데이터가 지워진 경우도 드러납니다.

## APP_ORIGIN

콘솔의 상태 변경 요청(POST·PATCH·PUT·DELETE)은 `Origin` 헤더를 검사해 CSRF 를 막습니다. 기준 주소는 `APP_ORIGIN` 입니다.

```bash
APP_ORIGIN=https://push.example.com   # 스킴 + 호스트(+ 포트), 끝 슬래시 없이
```

- 설정하면 `Origin` 이 이 값과 정확히 같아야 합니다
- 비워 두면 요청의 `Host` 와 `x-forwarded-proto` 로 기대 주소를 추정합니다. 동작은 하지만 리버스 프록시가 이 헤더를 어떻게 넘기느냐에 따라 결과가 달라집니다
- 프로덕션(`NODE_ENV=production`)에서 비어 있으면 첫 상태 변경 요청 때 서버 로그에 경고가 한 번 남습니다: `[notikit] APP_ORIGIN is not set ...`

프로덕션에서는 반드시 설정하세요.

## REDIS_URL — 공유 발송 한도

발송·클릭 등 v1 API 의 호출 한도는 기본적으로 **인스턴스마다 따로** 셉니다. 웹을 2대 이상 띄우면 실제 허용치가 대수만큼 늘어납니다.

```bash
REDIS_URL=redis://cache.example.com:6379    # rediss:// (TLS), redis://user:pass@host:6379/0 도 가능
```

- 설정하면 같은 프로젝트·같은 라우트의 카운터를 인스턴스끼리 공유합니다(고정 창)
- 비워 두면 지금처럼 메모리로만 세고, 로그에 `ratelimit.memory_only` 가 남습니다
- Redis 가 죽어도 요청은 막히지 않습니다. 메모리 판정으로 내려앉고(`redis.fallback`) 5초마다 한 번씩만 재연결을 시도합니다

한 대로 운영한다면 설정하지 않아도 됩니다.

### 지연 예산과 차단기

요청 하나가 Redis 를 기다리는 시간은 **200ms** 로 묶여 있습니다. 이 예산은 명령 응답뿐 아니라
**연결을 맺는 시간까지** 포함합니다 — 그러지 않으면 Redis 가 처음 느려지는 순간 모든 동시 요청이
연결 타임아웃(2초)까지 함께 기다리고, 로그인처럼 동시 처리 슬롯을 쥐고 기다리는 화면이
인증과 무관하게 503 을 돌려줍니다.

연결은 멀쩡한데 **응답만 느린** Redis 에는 차단기가 있습니다. 예산 초과가 연속 3회 나면 잠시
아예 묻지 않고 곧장 메모리 판정으로 갑니다(요청에 지연이 붙지 않습니다). 창이 지나면 요청
**하나만** 내보내 회복을 확인하고, 예산 안에 답이 오면 차단을 풉니다.

```bash
REDIS_DEGRADED_PROBE_MS=3000   # 차단 유지 시간(기본 3초). 지나면 1건만 재확인
```

차단 중 메모리로 판정한 횟수는 `/api/internal/metrics` 의 `shortCircuits` 로 봅니다.

## 관측 — 로그와 카운터

### 구조화 로그

web·worker 모두 **한 줄 JSON** 으로 찍습니다. 문장이 아니라 이벤트 이름으로 자르기 때문에
문구가 바뀌어도 집계가 깨지지 않습니다.

```json
{"reason":"connect exceeded the 200ms budget","affected":12,"ts":"2026-09-24T02:00:00.000Z","level":"warn","event":"redis.fallback","instance":"web-1:31"}
```

```bash
NOTIKIT_LOG_LEVEL=info    # debug | info | warn | error | silent (기본 info)
docker compose logs web | jq -c 'select(.level=="warn" or .level=="error")'
docker compose logs web | jq -r 'select(.event=="redis.fallback") | .reason' | sort | uniq -c
```

푸시 토큰·전화번호·이메일·시크릿·서명은 **필드 이름으로 걸러져 절대 찍히지 않습니다**.
자유 텍스트(예외 메시지)는 300자에서 잘립니다.

눈여겨볼 이벤트:

| event | 뜻 |
|---|---|
| `redis.fallback` | 공유 한도가 인스턴스별 계수로 내려앉았다(한도가 대수만큼 느슨해짐) |
| `redis.breaker_open` | Redis 가 느려 한동안 묻지 않기로 했다 |
| `ratelimit.memory_only` | `REDIS_URL` 이 없다 |
| `webhook.dead_letter` | 5회를 다 쓰고 포기한 배달 — 이벤트가 그대로 사라진 것 |
| `worker.token_sweep_failed` | 야간 토큰 점검이 실패했다(다음 tick 에 재시도) |
| `worker.project_list_failed` | 워커가 프로젝트 목록을 못 읽어 그 tick 을 건너뛰었다. `status` 가 401/403 이면 워커와 web 의 `ADMIN_TOKEN` 이 다르다 — 이 상태로는 **아무것도 발송되지 않는다** |

### 운영 지표 한 장

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "http://localhost:3000/api/internal/metrics?window_min=60" | jq .data
```

| 필드 | 범위 | 내용 |
|---|---|---|
| `sends` | DB(전체) | 창 안의 발송 처리량 — `processed`/`delivered`/`failed`, **사유별 실패**(`failuresByReason`), 포기한 발송 수 |
| `shared` | 클러스터 합계 | Redis 에 모은 `ratelimit.fallback`·`webhook.dead_letter`. Redis 가 없으면 `null` |
| `process` | **이 인스턴스만** | 공유 한도 상태(`fallbacks`·`shortCircuits`·`breakerMs`), 웹훅 데드레터, 이벤트 카운터 |

`process` 아래 숫자는 replica 하나의 조각입니다(`scope: "process"`). 웹을 2대 이상 띄웠다면
전체를 보려면 `shared` 를 보거나 인스턴스별로 각각 조회하세요. `sends` 는 DB 에서 읽으므로
인스턴스와 무관합니다.

`failuresByReason` 의 키는 FCM 오류 코드입니다(`messaging/quota-exceeded`,
`registration-token-not-registered` 등). "실패 120건"만으로는 쿼터 문제와 앱 삭제를
구분할 수 없어서 사유별로 나눠 둡니다.

## 웹훅 재시도

실패한 웹훅 배달은 워커가 지수 백오프로 다시 보냅니다. 간격은 **1분 → 5분 → 25분 → 125분**, 최대 5회입니다. 5회를 채우면 더 보내지 않고 `failed` 로 남습니다(배달 목록에서 마지막 응답 코드를 볼 수 있습니다).

- 재시도는 프로젝트별이 아니라 `POST /api/internal/webhooks/sweep` 한 번으로 전부 훑습니다(`ADMIN_TOKEN` 필요)
- 워커를 여러 대 띄워도 안전합니다. 배달 한 건은 한 워커만 가져갑니다
- 비활성화한 웹훅에는 재시도하지 않습니다

```bash
WORKER_WEBHOOK_SWEEP_MS=60000      # 스윕 주기(기본 60초, 최소 5초)
WORKER_SHUTDOWN_TIMEOUT_MS=30000   # 종료 신호 뒤 진행 중 작업을 기다리는 상한(기본 30초)
WORKER_REQUEST_TIMEOUT_MS=120000   # 요청 1건의 마감(기본 120초). 서버가 매달리면 tick 전체가 선다
WORKER_CONCURRENCY=4               # 한 tick 에서 동시에 처리하는 프로젝트 수(기본 4, 최대 64)
```

compose 의 `worker` 는 `stop_grace_period: 45s` 입니다. `WORKER_SHUTDOWN_TIMEOUT_MS` 보다
커야 합니다 — 작으면 Docker 가 대기 중인 워커를 SIGKILL 로 끊어, 이 설정이 지키려던
발송 결과 기록이 그대로 유실됩니다.

워커는 `SIGTERM`·`SIGINT` 를 받으면 새 작업을 시작하지 않고 진행 중인 것만 마친 뒤 내려갑니다. 배포 때 발송 기록이 유실되지 않게 하려는 것입니다. 상한을 넘기면 그대로 종료하고, 남은 일은 다음 기동이 이어받습니다.

재시도 간격은 **직전 실패 시각**을 기준으로 예약합니다(`webhook_deliveries.next_attempt_at`). 워커가 오래 멈췄다 다시 떠도 밀린 배달이 남은 재시도를 한꺼번에 소진하지 않고, 예약 시각이 된 것부터 하나씩 나갑니다.
