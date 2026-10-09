---
title: MCP 서버
---

# MCP 서버

AI 코딩 도구(Claude Code · Cursor · Claude Desktop)가 Notikit 을 직접 조작하게 합니다. "내 Flutter 앱에 푸시 붙여줘" 한마디로 프로젝트 조회 → 통합 코드 삽입 → 테스트 발송까지 AI 가 이어서 처리합니다.

| 도구 | 하는 일 |
|---|---|
| `list_projects` | 프로젝트 목록 (`id` · `orgId` · `apiKey`) |
| `create_project` | 프로젝트 생성, `api-key` · `api-secret` 발급 |
| `get_integration_snippet` | 플랫폼별 SDK 연동 코드 (서버 주소와 `api-key` 가 채워져 나옵니다) |
| `send_test_push` | 유저 한 명에게 테스트 발송 |
| `get_openapi` | OpenAPI 스펙 — AI 가 API 를 추측하지 않고 근거로 삼습니다 |

## 준비물

- **Node.js 20 이상** — MCP 서버는 AI 도구가 도는 **내 컴퓨터**에서 실행됩니다. Notikit 서버에 설치하는 것이 아닙니다.
- **서버 주소** — 예: `https://push.example.com`
- **관리자 토큰** — 서버 `.env` 의 `ADMIN_TOKEN` 값

```bash
# 서버에서
grep ^ADMIN_TOKEN= .env
```

> **`ADMIN_TOKEN` 은 인스턴스 전체의 최고 권한입니다.** 모든 조직의 프로젝트를 읽고 만들 수 있습니다. 설정 파일에 평문으로 들어가므로 저장소에 커밋되는 위치에 두지 말고, 공용 컴퓨터에서는 쓰지 마세요.

## 설치

아직 npm 에 올라가 있지 않아 소스에서 빌드합니다.

```bash
git clone https://github.com/mintsoft-opensource/notikit.git
cd notikit
pnpm install
pnpm --filter @notikit/mcp build
```

실행 파일은 `mcp/dist/index.js` 입니다. 아래 설정에는 이 파일의 **절대 경로**를 넣습니다.

```bash
echo "$(pwd)/mcp/dist/index.js"
```

## 연결

### Claude Code

```bash
claude mcp add notikit \
  --env NOTIKIT_BASE_URL=https://push.example.com \
  --env NOTIKIT_ADMIN_TOKEN=<관리자 토큰> \
  -- node /절대/경로/notikit/mcp/dist/index.js
```

기본 범위(local)는 이 컴퓨터의 현재 프로젝트에만 저장되고 저장소에 들어가지 않습니다. `--scope project` 는 `.mcp.json` 에 토큰을 적어 커밋 대상으로 만드므로 쓰지 마세요.

### Cursor

`~/.cursor/mcp.json` (모든 프로젝트) 또는 프로젝트의 `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "notikit": {
      "command": "node",
      "args": ["/절대/경로/notikit/mcp/dist/index.js"],
      "env": {
        "NOTIKIT_BASE_URL": "https://push.example.com",
        "NOTIKIT_ADMIN_TOKEN": "<관리자 토큰>"
      }
    }
  }
}
```

프로젝트 안에 둘 때는 `.cursor/mcp.json` 을 `.gitignore` 에 넣으세요.

### Claude Desktop

설정 > 개발자 > 설정 편집으로 `claude_desktop_config.json` 을 열고 위 Cursor 와 같은 내용을 넣은 뒤 앱을 다시 시작합니다.

| 변수 | 값 | 기본값 |
|---|---|---|
| `NOTIKIT_BASE_URL` | Notikit 서버 주소 (끝 슬래시 없이) | `http://localhost:3000` |
| `NOTIKIT_ADMIN_TOKEN` | 서버의 `ADMIN_TOKEN` | 없음 — 비우면 관리 도구가 `Unauthorized` |

## 확인

AI 도구에서 이렇게 물어봅니다.

```
notikit 프로젝트 목록 보여줘
```

`list_projects` 가 호출되고 `"status": 200` 과 프로젝트 목록이 돌아오면 연결된 것입니다. Claude Code 에서는 `/mcp` 로 서버 상태를 볼 수 있습니다.

## 쓰는 법

```
내 Flutter 앱에 Notikit 푸시 붙여줘. 프로젝트는 faircheck 를 써.
```

AI 가 `list_projects` 로 `apiKey` 를 찾고 → `get_integration_snippet(flutter)` 로 받은 코드를 앱에 넣습니다.

```
user-123 에게 테스트 푸시 보내줘
```

`send_test_push` 는 `api-key` 와 `api-secret` 이 둘 다 필요합니다. `api-secret` 은 프로젝트를 만들 때 한 번만 보이므로, 그때 저장해 둔 값을 AI 에게 알려줘야 합니다.

## 알아둘 점

- **프로젝트는 콘솔에서 먼저 만드는 편이 낫습니다.** `create_project` 를 `org_id` 없이 부르면 조직이 새로 만들어져, 콘솔에 로그인한 계정에서는 그 프로젝트가 보이지 않습니다. MCP 로 만들려면 `list_projects` 결과의 `orgId` 를 `org_id` 로 넘기세요.
- **`api-secret` 은 한 번만 나옵니다.** `create_project` 응답에 실려 오고, 이후에는 조회할 방법이 없습니다.
- **Firebase 를 올리기 전에는 실제로 발송되지 않습니다.** `send_test_push` 가 `202` 로 받아들여지고 로그에는 `logged` 로 남습니다(log-only). 연동 흐름을 확인하는 용도로는 충분합니다.
- **`send_test_push` 의 `target` 은 유저 ID 입니다.** 기기 토큰이 아니라, 기기를 등록할 때 넘긴 `user_id` 입니다.

## 문제 해결

| 증상 | 원인 |
|---|---|
| `"error": "Unauthorized"` | `NOTIKIT_ADMIN_TOKEN` 이 비었거나 서버의 `ADMIN_TOKEN` 과 다릅니다 |
| `fetch failed` | `NOTIKIT_BASE_URL` 이 틀렸거나 서버에 닿지 않습니다. `curl <주소>/api/ready` 로 확인하세요 |
| 도구가 목록에 없음 | `args` 의 경로가 절대 경로인지, `mcp/dist/index.js` 가 빌드돼 있는지 확인하세요 |
| 만든 프로젝트가 콘솔에 없음 | `org_id` 없이 만들었습니다 — 위 "알아둘 점" 참고 |
| 설정을 바꿨는데 그대로 | AI 도구를 다시 시작해야 환경 변수를 다시 읽습니다 |
