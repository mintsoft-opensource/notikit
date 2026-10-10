# @notikit/mcp

> Notikit MCP 서버(stdio) — **운영자용**. 인스턴스 전체를 다룬다(프로젝트 생성·목록).

**대부분은 이 패키지가 필요 없다.** Notikit 서버가 MCP 주소(`/api/mcp`)를 직접 열고, 프로젝트 화면에서
발급한 토큰으로 설치 없이 붙는다 → [MCP 서버 가이드](../apps/web/docs/11-mcp.md).

이 패키지는 서버 `.env` 의 `ADMIN_TOKEN`(인스턴스 전체 권한)으로 여러 프로젝트를 만들고 나열해야 할 때만 쓴다.

## 빌드

npm 에 올라가 있지 않다. 소스에서 빌드한다.

```bash
pnpm install
pnpm --filter @notikit/mcp build   # → mcp/dist/index.js
```

## 설정 (Claude Code / Cursor)
```json
{
  "mcpServers": {
    "notikit-admin": {
      "command": "node",
      "args": ["/absolute/path/to/notikit/mcp/dist/index.js"],
      "env": {
        "NOTIKIT_BASE_URL": "https://push.example.com",
        "NOTIKIT_ADMIN_TOKEN": "<admin-token>"
      }
    }
  }
}
```

`NOTIKIT_ADMIN_TOKEN` 은 서버 `.env` 의 `ADMIN_TOKEN` — 인스턴스 전체 권한이므로 커밋되는 파일에 두지 않는다.

## 도구
| 도구 | 설명 |
|---|---|
| `create_project` | 프로젝트 생성 + api-key/secret 발급. `org_id` 를 주지 않으면 조직이 새로 생긴다 |
| `list_projects` | 프로젝트 목록 |
| `get_integration_snippet` | 플랫폼별 SDK 통합 코드(실제 키 채움) |
| `send_test_push` | 테스트 발송 (`api-key` + `api-secret` 필요) |
| `get_openapi` | OpenAPI 스펙 |

## 라이선스
Apache-2.0
