---
title: MCP 서버
---

# MCP 서버

AI 코딩 도구(Claude Code · Cursor · Claude Desktop)가 Notikit 프로젝트를 직접 다루게 합니다. "내 Flutter 앱에 푸시 붙여줘" 한마디로 연동 코드 삽입 → 테스트 발송 → 결과 확인까지 AI 가 이어서 처리합니다.

Notikit 서버가 MCP 주소(`/api/mcp`)를 직접 엽니다. **설치할 것이 없습니다** — 프로젝트에서 토큰을 발급해 주소와 함께 AI 도구에 등록하면 끝입니다.

| 도구 | 하는 일 |
|---|---|
| `get_project` | 프로젝트 이름 · 환경 · `api-key` · 서버 주소 · Firebase 설정 여부 |
| `get_integration_snippet` | 플랫폼별 SDK 연동 코드 (서버 주소와 `api-key` 가 채워져 나옵니다) |
| `send_test_push` | 유저 한 명에게 테스트 발송 |
| `list_recent_sends` | 최근 발송의 상태와 성공 · 실패 수 |
| `get_openapi` | OpenAPI 스펙 — AI 가 API 를 추측하지 않고 근거로 삼습니다 |

## 연결

### 1. 토큰 발급

콘솔에서 **프로젝트 → 관리 → MCP 연결** 로 들어가 **토큰 발급**을 누릅니다.

- 토큰은 **그 프로젝트 하나만** 다룹니다. 다른 프로젝트나 조직 설정에는 닿지 않습니다.
- 발급할 때 **한 번만** 보입니다. 놓쳤으면 다시 발급하면 됩니다.
- 다시 발급하면 이전 토큰은 그 즉시 쓸 수 없습니다. 토큰이 새어 나갔다고 의심되면 바로 다시 발급하세요.
- 발급과 폐기는 감사 로그에 남습니다.

같은 화면에 아래 설정이 서버 주소와 토큰이 채워진 채로 나옵니다. 복사해서 쓰면 됩니다.

### 2. AI 도구에 등록

**Claude Code**

```bash
claude mcp add --transport http notikit https://push.example.com/api/mcp \
  --header "Authorization: Bearer <MCP 토큰>"
```

기본 범위(local)는 이 컴퓨터의 현재 프로젝트에만 저장되고 저장소에 들어가지 않습니다. `--scope project` 는 `.mcp.json` 에 토큰을 적어 커밋 대상으로 만드므로 쓰지 마세요.

**Cursor** — `~/.cursor/mcp.json` (모든 프로젝트) 또는 프로젝트의 `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "notikit": {
      "url": "https://push.example.com/api/mcp",
      "headers": { "Authorization": "Bearer <MCP 토큰>" }
    }
  }
}
```

프로젝트 안에 둘 때는 `.cursor/mcp.json` 을 `.gitignore` 에 넣으세요.

**Claude Desktop** — 설정 > 개발자 > 설정 편집으로 `claude_desktop_config.json` 을 열고 아래를 넣은 뒤 앱을 다시 시작합니다. 설정 파일이 원격 주소에 헤더를 직접 붙이지 못해 `mcp-remote` 로 잇습니다(Node.js 필요).

```json
{
  "mcpServers": {
    "notikit": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://push.example.com/api/mcp", "--header", "Authorization: Bearer <MCP 토큰>"]
    }
  }
}
```

### 3. 확인

AI 도구에서 이렇게 물어봅니다.

```
notikit 프로젝트 정보 보여줘
```

`get_project` 가 호출되고 프로젝트 이름과 `api_key` 가 돌아오면 연결된 것입니다. Claude Code 에서는 `/mcp` 로 서버 상태를 볼 수 있습니다.

## 쓰는 법

```
내 Flutter 앱에 Notikit 푸시 붙여줘.
```

AI 가 `get_integration_snippet(flutter)` 로 받은 코드를 앱에 넣습니다. 서버 주소와 `api-key` 는 이미 채워져 있습니다.

```
user-123 에게 테스트 푸시 보내고 결과 확인해줘
```

`send_test_push` 로 보내고 `list_recent_sends` 로 상태를 확인합니다. `api-secret` 을 알려줄 필요가 없습니다 — 토큰이 그 프로젝트의 발송 권한을 갖습니다.

## 알아둘 점

- **Firebase 를 올리기 전에는 실제로 발송되지 않습니다.** `send_test_push` 는 받아들여지고 로그에 `logged` 로 남습니다(log-only). `get_project` 의 `firebase_configured` 로 확인할 수 있습니다.
- **`send_test_push` 의 `target` 은 유저 ID 입니다.** 기기 토큰이 아니라, 기기를 등록할 때 넘긴 `user_id` 입니다.
- **테스트 발송은 통계에서 빠집니다.** 방해금지 시간대도 적용받지 않습니다 — 지금 받아 보려고 보내는 것이기 때문입니다.
- **프로젝트를 만들거나 지우는 도구는 없습니다.** 토큰의 권한이 한 프로젝트 안에 머물도록 일부러 뺐습니다. 프로젝트는 콘솔에서 만드세요.
- **토큰은 발송 권한입니다.** 저장소에 커밋되는 파일이나 공용 컴퓨터에 두지 마세요.

## 문제 해결

| 증상 | 원인 |
|---|---|
| `401 Unauthorized` | 토큰이 틀렸거나, 다시 발급해서 이전 토큰이 죽었습니다. 헤더가 `Authorization: Bearer nkm_…` 형태인지 확인하세요 |
| `429 Rate limit exceeded` | 짧은 시간에 너무 많이 호출했습니다. 잠시 뒤 다시 시도하세요 |
| 연결이 안 됨 | 주소가 `https://<서버>/api/mcp` 인지 확인하세요. `curl <서버>/api/ready` 로 서버가 살아 있는지 봅니다 |
| 발송했는데 기기에 안 옴 | Firebase 가 설정되지 않았거나(`firebase_configured: false`), 그 `user_id` 로 등록된 기기가 없습니다 |
| 설정을 바꿨는데 그대로 | AI 도구를 다시 시작해야 설정을 다시 읽습니다 |

## 인스턴스 전체를 다루려면

여러 프로젝트를 만들고 나열하는 자동화가 필요하면 저장소의 `mcp/` 패키지(내 컴퓨터에서 실행하는 stdio 서버)를 쓸 수 있습니다. 서버 `.env` 의 `ADMIN_TOKEN` 을 요구하고, 이 값은 **인스턴스 전체의 최고 권한**이므로 운영자 본인만 쓰세요. 설정 방법은 `mcp/README.md` 에 있습니다.
