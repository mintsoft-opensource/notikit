---
title: 업데이트
---

# 업데이트

인스턴스를 새 버전으로 올리는 방법과, 그때 실제로 무슨 일이 일어나는지.

## 워드프레스와 다른 점

워드프레스는 파일을 덮어쓰면 다음 요청부터 새 코드가 돕니다. PHP라 빌드가 없기 때문입니다.

Notikit은 컴파일된 산출물입니다. 파일을 바꿔도 이미 돌고 있는 프로세스는 달라지지 않고, 고객사 박스에서 빌드를 돌리면 수 분과 메모리를 쓰며 **빌드가 깨지면 설치본이 망가진 채로 남습니다.** 그래서 업데이트는 파일 교체가 아니라 **이미지 교체**입니다.

## 무엇이 이 일을 하는가

`updater` 컨테이너입니다. Docker 소켓을 쥐는 **유일한** 컨테이너이고, 포트를 열지 않습니다.

`web` 과는 **다른 이미지**입니다. 업데이터에는 docker CLI 와 `pg_dump` 가 들어 있고 Next 서버는 없습니다. `NOTIKIT_UPDATER_IMAGE` 를 `.env` 에 반드시 지정하세요 — 비워 두면 compose 가 기동을 거부합니다. 예전에는 비어 있으면 web 이미지로 내려앉았는데, 그러면 Next 서버가 Docker 소켓을 쥔 채 뜨고(바로 위에서 막으려던 구성입니다) 업데이트 작업은 아무도 집어가지 않아 콘솔에서 영원히 대기했습니다.

콘솔과는 데이터베이스로만 이야기합니다. 콘솔이 `update_jobs`에 행을 넣으면 업데이터가 집어 갑니다. 이렇게 나눈 이유는 `web`에 Docker 소켓을 주지 않기 위해서입니다 — 소켓은 사실상 호스트 root 권한이라, 공개 API를 서빙하는 프로세스가 쥐고 있으면 거기서 나는 사고 하나가 곧 호스트 장악이 됩니다.

## 순서가 곧 안전장치다

```
받기 → 백업 → 마이그레이션 → 교체 → 확인
```

**마이그레이션을 교체보다 먼저** 돌립니다. 여기서 실패하면 구버전 `web`이 그대로 살아 있어 서비스가 끊기지 않습니다. 순서를 뒤집으면 실패한 순간 내려간 채로 남습니다.

스키마를 바꾸는 릴리스는 **반드시 백업을 먼저** 뜹니다. 마이그레이션은 앞으로만 가므로, 되돌릴 길이 그 덤프뿐입니다. 백업이 실패하면 업데이트를 진행하지 않습니다.

## 되돌리기

| 상황 | 되돌리는 방법 |
|---|---|
| 마이그레이션 없는 릴리스가 health check 실패 | **자동.** 이전 이미지로 되돌리고 다시 띄웁니다 |
| 마이그레이션 있는 릴리스가 health check 실패 | **수동.** 스키마가 이미 앞으로 갔으므로 자동으로 되돌리지 않습니다 |

두 번째 경우에 이미지만 되돌리면 구버전 코드가 새 스키마를 만납니다. 어설픈 자동 복구가 더 큰 손상을 만들기 때문에, 콘솔은 백업 위치를 보여 주고 멈춥니다.

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" /backups/notikit-1.2.0-....dump
```

## 받는 것을 고정한다

업데이트 서버는 태그가 아니라 **다이제스트**(`sha256:…`)를 내려보냅니다. 태그는 나중에 다른 이미지를 가리키도록 바뀔 수 있어서, 콘솔에서 승인한 것과 실제로 설치되는 것이 달라질 수 있습니다. 다이제스트가 없는 응답은 거부합니다.

승인 시점의 이미지와 다이제스트는 작업 행에 박힙니다. 업데이터가 다시 조회하지 않는 이유는, 두 번 물으면 그 사이에 답이 바뀔 수 있기 때문입니다.

## 건너뛸 수 없는 버전

릴리스는 `minUpgradeFrom`을 가질 수 있습니다. 현재 버전이 그보다 낮으면 콘솔이 설치를 막고 중간 버전을 먼저 설치하게 합니다. 마이그레이션을 건너뛰면 스키마가 어긋난 채로 뜹니다.

## 누가 누를 수 있나

**인스턴스 운영자**뿐입니다. 조직 소유자(`role: owner`)와 다릅니다.

멀티테넌트로 운영하면 `owner`는 고객사 소유자입니다. 그 사람이 인스턴스 전체를 재시작할 수 있으면 안 됩니다. 운영자는 부트스트랩 조직(가장 먼저 만들어진 org)의 소유자이거나 `ADMIN_TOKEN`을 쥔 쪽입니다.

그리고 기능 자체가 기본으로 꺼져 있습니다. `NOTIKIT_SELF_UPDATE=true`를 켜야 경로가 열립니다.

## 구독이 만료되면

업데이트만 막힙니다. **돌고 있는 설치는 계속 동작합니다.** 결제 상태로 고객의 푸시를 멈추지 않습니다.

## 설정

```bash
NOTIKIT_SELF_UPDATE=true
NOTIKIT_UPDATE_SERVER=https://updates.example.com
NOTIKIT_LICENSE_KEY=...
NOTIKIT_UPDATE_CHANNEL=stable

REGISTRY_SERVER=registry.example.com
REGISTRY_USERNAME=...
REGISTRY_PASSWORD=...

NOTIKIT_UPDATER_IMAGE=registry.example.com/notikit-updater:0.1.0
```

돌고 있는 이미지는 `.notikit-image.env` 한 줄에 있고 업데이터가 갱신합니다. compose 파일 본문은 건드리지 않습니다 — 고객이 손댄 설정과 충돌하기 때문입니다.

그 파일은 **업데이터 소유**입니다. 갱신할 때 통째로 덮어쓰므로 다른 설정을 같이 두지 마세요. 고객 설정은 `.env` 에 둡니다.

## `--env-file` 을 빠뜨리지 않는다

compose 는 프로젝트 디렉터리의 `.env` **하나만** 치환(`${NOTIKIT_IMAGE}`)에 씁니다. 서비스의 `env_file:` 은 컨테이너 환경변수일 뿐 치환과 무관합니다. 그래서 `.notikit-image.env` 는 **명시하지 않으면 아무도 읽지 않습니다.**

빠뜨리면 업데이터가 그 줄을 바꿔도 compose 가 계속 예전 이미지를 띄웁니다 — 업데이트도 되돌리기도 "성공"으로 기록되는데 실제로는 아무것도 바뀌지 않습니다. 지금은 값이 비면 compose 가 기동을 거부하므로 조용히 어긋나지는 않습니다.

```bash
export COMPOSE_FILE=docker-compose.prod.yml
export COMPOSE_ENV_FILES=.env,.notikit-image.env
docker compose up -d        # 이후 모든 compose 명령이 두 파일을 읽는다
```

업데이터는 이 두 파일을 스스로 넘기므로 콘솔에서 누르는 업데이트에는 위 설정이 필요 없습니다. 손으로 `docker compose` 를 칠 때만 필요합니다.

## 최초 설치

```bash
echo "NOTIKIT_IMAGE=registry.example.com/notikit@sha256:..." > .notikit-image.env
docker compose -f docker-compose.prod.yml \
  --env-file .env --env-file .notikit-image.env up -d
```

`migrate` 는 web 과 **같은 런타임 이미지**로 돕니다. 레지스트리 이미지 하나로 마이그레이션까지 끝나야 하므로, 그 이미지에 `migrate.mjs` 가 쓰는 `postgres`·`drizzle-orm` 이 함께 들어 있습니다.
