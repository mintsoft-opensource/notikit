---
title: 클릭 추적
---

# 클릭 추적

발송 payload 의 `data` 에 `notikit_log_id` 가 실려 나갑니다. 알림을 눌렀을 때 이 값을 되돌려주면 클릭으로 집계됩니다. SDK 를 쓰면 자동으로 처리됩니다.

```bash
curl -X POST https://push.example.com/api/v1/messages/click \
  -H "content-type: application/json" \
  -H "api-key: nk_xxx" \
  -d '{
    "log_id": "<notikit_log_id>",
    "token": "<이 기기의 푸시 토큰>",
    "destination": "myapp://cart"
  }'
```

- 유저는 서버가 토큰의 바인딩에서 해석합니다 — `external_id` 를 보내지 않습니다
- 같은 발송·같은 기기의 재클릭은 무시됩니다(클릭률이 부풀지 않게)
- 발송 시각 이후에 등록된 기기의 클릭은 거부됩니다 — 가짜 토큰을 등록해 과거 발송을 클릭하는 경로를 막습니다
