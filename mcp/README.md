# @notikit/mcp

> Notikit MCP 서버 — AI 코딩 도우미(Claude Code/Cursor)가 Notikit 을 도구로 조작.
> 프로젝트 생성·통합 스니펫 생성·테스트 발송을 AI 루프 안에서.

## 설정 (Claude Code / Cursor)
```json
{
  "mcpServers": {
    "notikit": {
      "command": "npx",
      "args": ["-y", "@notikit/mcp"],
      "env": {
        "NOTIKIT_BASE_URL": "https://push.example.com",
        "NOTIKIT_ADMIN_TOKEN": "<admin-token>"
      }
    }
  }
}
```

## 도구
| 도구 | 설명 |
|---|---|
| `create_project` | 프로젝트 생성 + api-key/secret 발급 |
| `list_projects` | 프로젝트 목록 |
| `get_integration_snippet` | 플랫폼별 SDK 통합 코드(실제 키 채움) ⭐ |
| `send_test_push` | 테스트 발송 |
| `get_openapi` | OpenAPI 스펙 |

→ "내 Flutter 앱에 푸시 붙여줘" → AI 가 `create_project` → `get_integration_snippet(flutter)` → 코드 삽입 → `send_test_push` 로 검증.

## 라이선스
Apache-2.0
