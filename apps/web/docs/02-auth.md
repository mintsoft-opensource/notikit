---
title: 인증
---

# 인증

키는 두 종류입니다. 용도를 섞으면 보안이 무너집니다.

| 키 | 헤더 | 어디에 두나 | 할 수 있는 일 |
|---|---|---|---|
| `api-key` (nk_…) | `api-key` | 클라이언트 SDK 에 포함 (공개) | 디바이스 등록, 유저 식별, 토픽 구독, 클릭 보고, 수신거부 |
| `api-secret` (sk_…) | `api-secret` | 서버 전용 (절대 앱에 넣지 않음) | 발송 |

> **api-key 는 비밀이 아닙니다.** 앱에 실려 배포되므로 공격자가 가지고 있다고 전제하고 설계돼 있습니다. 발송은 `api-secret` 이 있어야만 가능합니다.

## identity_hash

남의 계정을 사칭하지 못하도록, `external_id` 를 다루는 요청에는 `identity_hash` 를 요구합니다. 고객 서버가 계산해 클라이언트에 내려주세요.

```
identity_hash = HMAC-SHA256(external_id, api_secret) → hex
```

```js
// Node.js — 고객 서버에서
import { createHmac } from "node:crypto";

const identityHash = createHmac("sha256", API_SECRET)
  .update(externalId)
  .digest("hex");

// 이 값을 로그인 응답에 담아 앱으로 내려줍니다.
// api_secret 자체는 절대 앱으로 내려보내지 마세요.
```

**항상 필수**: 인박스 조회·읽음, 저니 등록, external_id 수신거부, 토큰 교체(유저 바인딩된 기기)

**프로젝트 설정 시 필수**: 디바이스 등록의 external_id 바인딩, 바인딩 해제, 유저 식별

프로젝트 설정 > 정책에서 "유저 검증 요구"를 끄면 후자는 생략됩니다(개발 중에만 권장).
