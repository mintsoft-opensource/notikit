# 백업 · 복구 런북

> 고객사 인스턴스의 DB 백업과 복구 절차. **운영자가 장애 중에 읽는 문서**다.
> 설명은 짧게, 명령은 그대로 복사해 쓸 수 있게.
>
> 관련: [DISTRIBUTION.md](DISTRIBUTION.md)(릴리스·업데이트) · [plan/03-server-architecture.md](plan/03-server-architecture.md)

---

## 0. 먼저 알아야 할 것

### 🔴 자동 백업은 **업데이트할 때만** 뜬다

지금 구현된 백업은 **업데이터가 마이그레이션 직전에 뜨는 덤프 하나뿐**이다.

- 마이그레이션이 **없는** 릴리스에서는 뜨지 않는다 (되돌릴 것이 컨테이너뿐이라)
- 업데이트를 하지 않는 기간에는 **새 백업이 생기지 않는다**
- 즉 디스크 고장, 실수로 지운 데이터, 랜섬웨어에는 **복구할 것이 없다**

**예약 백업은 §1 에서 운영자가 직접 걸어야 한다.** 이걸 안 걸면 마지막 업데이트
시점으로만 돌아갈 수 있다.

### 🔴 `NOTIKIT_ENCRYPTION_KEY` 가 없으면 복구해도 못 쓴다

프로젝트별 Firebase 자격증명은 이 키로 AES-256-GCM 암호화되어 DB 에 들어간다.
**DB 를 복구해도 키가 다르면 자격증명을 복호화할 수 없고, 발송이 전부 실패한다.**

키는 DB 백업과 **별도로, 다른 곳에** 보관한다. 같은 디스크에 두면 그 디스크가
죽을 때 둘 다 사라진다.

---

## 1. 예약 백업 설정 (인수인계 필수)

호스트 cron 에 건다. 컨테이너 안에 넣지 않는 이유: 업데이트가 컨테이너를 교체하므로
그 안의 스케줄은 교체 때마다 사라진다.

```bash
# /etc/cron.d/notikit-backup
# 매일 03:10 에 덤프. 경로는 설치 디렉터리에 맞게 고칠 것.
10 3 * * * root cd /opt/notikit && /usr/bin/docker compose -f docker-compose.prod.yml \
  exec -T postgres pg_dump -U notikit --format=custom --no-owner notikit \
  > /opt/notikit/backups/daily-$(date +\%Y\%m\%d).dump 2>> /var/log/notikit-backup.log
```

**보관 주기도 같이 건다.** 안 걸면 백업이 디스크를 채워, 백업이 장애 원인이 된다.

```bash
# 30일 지난 덤프 삭제
30 3 * * * root find /opt/notikit/backups -name 'daily-*.dump' -mtime +30 -delete
```

### 점검 (인수인계 체크리스트)

```bash
ls -lh /opt/notikit/backups/          # 어제 날짜 파일이 있는가
du -sh /opt/notikit/backups/          # 증가 속도가 디스크를 위협하지 않는가
df -h /                               # 여유 공간
```

⚠️ **복구를 한 번도 해보지 않은 백업은 백업이 아니다.** 인수인계 때 §3 을 실제로
한 번 돌려 본다(스테이징 또는 임시 DB 로).

---

## 2. 백업 파일 알아보기

| 파일 | 만든 주체 | 언제 |
|---|---|---|
| `notikit-<버전>-<타임스탬프>.dump` | 업데이터 | 마이그레이션 있는 업데이트 **직전** |
| `daily-<날짜>.dump` | §1 의 cron | 매일 |

둘 다 `pg_dump --format=custom --no-owner` 형식이다. 텍스트가 아니므로 `psql` 로는
못 넣는다 — `pg_restore` 를 쓴다.

업데이터가 뜬 덤프의 경로는 DB 에도 남는다:

```sql
select id, target_version, status, backup_path, created_at
  from update_jobs order by created_at desc limit 10;
```

콘솔 **업데이트** 화면의 이력에서도 같은 값을 볼 수 있다(인스턴스 운영자 계정).

---

## 3. 복구

### 3-1. 멈춘다

복구 중에 앱이 쓰기를 하면 복구본과 섞인다.

```bash
cd /opt/notikit
docker compose -f docker-compose.prod.yml stop web worker updater
# postgres 는 살려 둔다 — 복구 대상이다
```

### 3-2. 지금 상태를 먼저 뜬다

**복구가 틀린 백업이었을 때 돌아올 곳이 필요하다.** 이걸 건너뛰면 되돌릴 수 없다.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U notikit --format=custom --no-owner notikit \
  > backups/before-restore-$(date +%Y%m%d-%H%M%S).dump
```

### 3-3. 복원

```bash
# <FILE> 을 복원할 덤프로 바꾼다
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U notikit -d notikit --clean --if-exists --no-owner \
  < backups/<FILE>
```

- `--clean --if-exists` — 기존 객체를 지우고 덮어쓴다. 없으면 "이미 있다" 오류가 쏟아진다
- `--no-owner` — 덤프의 소유자 정보를 무시하고 접속 롤로 만든다. 덤프를 뜬 환경과
  롤 이름이 달라도 들어간다

`pg_restore` 는 일부 경고를 내면서도 성공한다. **마지막 줄의 종료 코드를 본다.**

### 3-4. 확인

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U notikit -d notikit -c "
    select (select count(*) from organizations) as orgs,
           (select count(*) from projects)      as projects,
           (select count(*) from devices)       as devices;"
```

### 3-5. 스키마 버전을 맞춘다 — **가장 자주 틀리는 지점**

복원한 덤프가 **현재 이미지보다 오래된 스키마**일 수 있다. 그 상태로 web 을 올리면
새 코드가 옛 스키마를 만난다.

```bash
# 마이그레이션은 멱등하다. 이미 적용된 것은 건너뛴다.
docker compose -f docker-compose.prod.yml up --no-deps --force-recreate migrate
```

반대 경우 — **덤프가 현재 이미지보다 새 스키마**라면 마이그레이션으로 해결되지 않는다.
그때는 이미지를 그 스키마에 맞는 버전으로 되돌려야 한다:

```bash
cat .notikit-image.env                 # 지금 돌고 있는 이미지
# 이전 다이제스트로 한 줄을 바꾸고
docker compose -f docker-compose.prod.yml up -d
```

### 3-6. 올린다

```bash
docker compose -f docker-compose.prod.yml up -d
curl -fsS localhost:3000/api/ready     # {"status":"ready"} 여야 한다
```

`/api/health` 가 아니라 `/api/ready` 를 본다 — health 는 DB 가 죽어도 200 이다.

---

## 4. 상황별

### 업데이트가 실패해서 되돌려야 한다

**마이그레이션이 없던 릴리스**면 업데이터가 이미 자동으로 되돌렸다. 로그를 확인한다.

**마이그레이션이 있던 릴리스**면 자동으로 되돌리지 않는다 — 스키마가 이미 움직였으므로
컨테이너만 되돌려도 복구가 아니다. 순서는:

1. `update_jobs` 에서 그 작업의 `backup_path` 를 찾는다
2. §3 으로 그 덤프를 복원한다
3. `.notikit-image.env` 를 이전 다이제스트로 되돌린다
4. `docker compose up -d`

### 특정 테이블만 날렸다

전체 복원은 다른 테이블의 최신 데이터까지 되돌린다. 부분 복원이 낫다:

```bash
# 덤프 안의 목록 확인
pg_restore -l backups/<FILE> | grep -i '<테이블명>'

# 그 테이블만
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U notikit -d notikit --data-only -t <테이블명> --no-owner < backups/<FILE>
```

⚠️ FK 가 걸린 테이블은 단독 복원이 참조 무결성을 깨뜨릴 수 있다. `push_logs` 를
되돌리면 `push_clicks` 와 어긋난다.

### 디스크가 찼다

가장 흔한 원인은 **로그 누적**이다. `LOG_RETENTION_DAYS` 가 설정돼 있는지부터 본다.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U notikit -d notikit -c "
    select pg_size_pretty(pg_total_relation_size('push_logs')) as push_logs,
           pg_size_pretty(pg_database_size('notikit'))         as total;"
```

`LOG_RETENTION_DAYS` 가 비어 있으면 purge 가 돌지 않는다. `.env` 에 넣고 **web 을**
재시작한다 — 이 값을 읽는 쪽은 worker 가 아니라 web 이다(worker 는 호출만 한다).

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate web worker
```

다음 야간 창을 기다리지 않고 즉시 비우려면 프로젝트별로 직접 호출한다
(콘솔 화면은 아직 없다):

```bash
# 대상 건수 먼저 확인
curl -fsS -H "x-admin-token: $ADMIN_TOKEN" \
  localhost:3000/api/admin/projects/<PROJECT_ID>/logs/purge

# 실행 — 한 번에 최대 10만 행(5,000 × 20). 남으면 done:false 이므로 반복한다
curl -fsS -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  localhost:3000/api/admin/projects/<PROJECT_ID>/logs/purge
```

백업 파일 누적도 확인한다 — §1 의 보관 주기를 안 걸었으면 여기가 원인이다.

### 암호화 키를 잃었다

**복구 불가.** 프로젝트별 Firebase 자격증명을 되살릴 방법이 없다. 각 프로젝트에서
자격증명을 다시 등록하는 것 외에 방법이 없다. 디바이스·유저·로그 등 나머지 데이터는
영향이 없다.

---

## 5. RTO / RPO

계약서에 쓰기 전에 **실제로 측정한다.** 아래는 측정 항목이지 약속값이 아니다.

| | 재는 법 |
|---|---|
| **RPO**(유실 허용) | 백업 주기. §1 의 일 1회면 최대 24시간 |
| **RTO**(복구 시간) | §3 을 실제 데이터 크기로 한 번 돌려 초시계로 잰다 |

덤프 복원 시간은 데이터 크기에 거의 비례하므로, **고객사 실제 볼륨으로 재지 않은
숫자를 계약서에 넣지 않는다.**
