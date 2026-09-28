# 배포 — 릴리스와 운영 설치

Notikit 은 Apache-2.0 오픈소스다. 서버 이미지(`ghcr.io/mintsoft-opensource/notikit`)는 공개돼 있어
누구나 로그인 없이 받아 셀프호스트할 수 있다.

이 문서는 **메인테이너가 읽는 문서**다. 릴리스를 만드는 절차와, 지원 계약을 맺은 설치에
업데이트를 관리형으로 내려보내는 절차(선택)를 다룬다.

라이선스는 **공식 업데이트 채널을 쓰는 설치에만** 필요하다. 라이선스가 없어도 발송·콘솔·API 는
모두 그대로 동작하고, 업데이트 서버를 통한 자동 업데이트만 받지 않는다 — 셀프호스트는 새 이미지를
직접 받아 올리면 된다.

## 구성 요소

| 것 | 어디서 도나 | 하는 일 |
|---|---|---|
| `packages/license` | 모두가 공유 | Ed25519 서명·검증. 빌드 단계가 없어 web·서버·CLI 가 같은 코드를 쓴다 |
| `tools/license/issue.mjs` | 우리 장비 | 라이선스 발급 |
| `apps/update-server` | **우리** 인프라 | 라이선스 확인 후 이 설치가 받을 릴리스를 알려 준다 (관리형 업데이트용) |
| `apps/updater` | **설치된** 서버 | 실제 교체. Docker 소켓을 쥐는 유일한 컨테이너 |
| `tools/release/*` | CI | 매니페스트 생성, 폐쇄망 번들 제작 |

## 1. 관리형 업데이트 최초 준비 (한 번, 선택)

```bash
node tools/license/issue.mjs keygen
# license-private.pem  ← 발급 장비에만. 저장소·이미지에 절대 넣지 않는다
# license-public.pem   ← NOTIKIT_LICENSE_PUBLIC_KEY 로 이미지에 들어간다
```

비밀키를 잃으면 기존 라이선스는 그대로 동작하지만 **새로 발급할 수 없다.** 공개키를 바꾸면 **모든 고객의 라이선스가 한꺼번에 무효가 된다.** 둘 다 복구 불가이므로 오프라인 백업을 둔다.

## 2. 지원 계약 설치 등록 (선택)

```bash
NOTIKIT_LICENSE_PRIVATE_KEY_FILE=./license-private.pem \
  node tools/license/issue.mjs issue \
    --customer acme --name "Acme 주식회사" \
    --months 12 --projects 10 --devices 500000 --sends 20000000
```

라이선스는 업데이트 서버가 이 설치에 어떤 릴리스를 내려보낼지 정하는 데 쓴다. 계약이 끝나 라이선스가 만료돼도 돌고 있는 설치는 그대로 동작하고, 관리형 업데이트만 멈춘다.

## 3. 릴리스

```bash
# apps/web/package.json 의 version 을 올리고
git tag v1.2.0 && git push --tags
```

CI(`.github/workflows/release.yml`)가 나머지를 한다.

- 태그와 `package.json` 버전이 다르면 **거기서 멈춘다.** 어긋나면 콘솔이 잘못된 버전을 보고한다
- amd64/arm64 둘 다 빌드한다. 고객 하드웨어가 무엇일지 모른다
- cosign 으로 서명한다
- `hasMigrations` 를 **저널 비교로 판정한다.** 손으로 적으면 언젠가 틀리고, 틀리는 날은 고객 스키마가 백업 없이 바뀌는 날이다
- 다이제스트를 업데이트 서버에 등록한다. 태그가 아니다 — 태그는 나중에 다른 이미지를 가리키게 바뀔 수 있다
  - `UPDATE_SERVER_URL` 시크릿이 없으면 등록만 건너뛰고 나머지는 그대로 한다(업데이트 서버 없이 시작할 때)
- 폐쇄망 번들을 만들어 아티팩트로 올린다

레지스트리는 `REGISTRY_SERVER` 변수가 없으면 **GHCR**(`ghcr.io/mintsoft-opensource/notikit`, `…/notikit-updater`)이다.
CI 는 `GITHUB_TOKEN` 으로 푸시하므로 준비할 계정·시크릿이 없다. 두 패키지 모두 공개라 설치할 서버는
로그인 없이 받는다:

```bash
echo "NOTIKIT_IMAGE=ghcr.io/mintsoft-opensource/notikit:0.1.0" > .notikit-image.env
docker compose -f docker-compose.prod.yml --env-file .env --env-file .notikit-image.env up -d
```

## 4. 배포 제어

`apps/update-server/customers.json`:

```json
{
  "acme":   { "pin": "1.1.0" },
  "beta-co":{ "channel": "beta" },
  "gone":   { "blocked": true }
}
```

`pin` 이 중요하다. 특정 릴리스에 문제가 생겼을 때 **그 고객만** 세워 둘 수 있다. 이런 수단이 없으면 할 수 있는 일이 "모두에게 배포 중단"뿐이다.

문제가 있는 릴리스는 해당 `releases/*.json` 에 `"yanked": true` 를 넣으면 아무에게도 나가지 않는다.

## 5. 폐쇄망 설치

금융·공공에서는 사실상 기본값이다.

1. CI 아티팩트에서 `notikit-<버전>-airgap.tar` 와 `.sha256`, `.tar.json` 을 받는다
2. 세 파일을 설치 서버의 `./bundles/` 에 반입한다
3. 콘솔 **업데이트** 화면에 번들이 나타난다 → 설치

번들은 라이선스 없이도 설치할 수 있다.

`.sha256` 이 없으면 콘솔이 설치를 거부한다. 번들은 USB 와 사람 손을 거쳐 오므로, 받은 것이 보낸 것과 같은지 확인하지 못하면 무엇을 설치하는지 모르는 채로 설치하는 것이다.

업데이터는 체크섬을 다시 확인하고, 번들이 가리키는 이미지가 콘솔에서 승인한 이미지와 같은지도 확인한다.

## 6. 장애 대응

DB 를 되돌려야 하는 상황은 [BACKUP-RESTORE.md](BACKUP-RESTORE.md) 를 따른다.
특히 **마이그레이션이 있던 릴리스는 자동 롤백되지 않는다** — 컨테이너만 되돌려도
스키마가 이미 움직였으므로 복구가 아니다.


고객에게 **지원 번들**을 요청한다 (콘솔 > 업데이트 > 지원 번들).

담기는 것: 버전, 런타임, 어떤 설정이 채워져 있는지, 적용된 마이그레이션, 각종 건수, 업데이트 기록과 로그.
**담기지 않는 것: 값. 비밀번호도 키도 라이선스 원문도.** 이 파일은 메일과 메신저를 타고 돌아다니게 되어 있다.

## 자주 틀리는 것

**공개키를 바꾸지 마라.** 관리형 업데이트를 받는 모든 설치의 라이선스가 한꺼번에 무효가 된다.

**이미 배포된 마이그레이션 파일을 고치지 마라.** drizzle 저널은 적용된 것을 다시 실행하지 않아, 고친 내용이 기존 설치에 영원히 반영되지 않는다. 새 마이그레이션을 추가한다.

**`latest` 태그로 배포하지 마라.** 고객이 무엇을 받을지 고정되지 않는다. 다이제스트를 쓴다.
