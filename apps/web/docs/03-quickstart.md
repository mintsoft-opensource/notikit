---
title: 빠른 시작
---

# 빠른 시작

1. 프로젝트를 만들고
2. Firebase 서비스 계정 JSON 을 올린 뒤
3. SDK 를 연동합니다.

> Firebase 를 설정하지 않아도 발송을 호출할 수 있습니다. 이 경우 실제 배달 없이 로그만 남습니다(**log-only**) — 연동 전에 흐름을 확인할 때 유용합니다.

## 디바이스 등록

모든 플랫폼 공통 · 공개 api-key

```bash
curl -X POST https://push.example.com/api/v1/devices \
  -H "content-type: application/json" \
  -H "api-key: nk_xxx" \
  -d '{
    "token": "<FCM 등록 토큰>",
    "platform": "android",
    "user_id": "user-123",
    "identity_hash": "<서버계산 HMAC>",
    "locale": "ko-KR",
    "timezone": "Asia/Seoul"
  }'
```

## 발송

서버 전용 · api-secret 필요

```bash
curl -X POST https://push.example.com/api/v1/messages \
  -H "content-type: application/json" \
  -H "api-key: nk_xxx" \
  -H "api-secret: sk_xxx" \
  -d '{
    "type": "single",
    "target": "user-123",
    "title": "장바구니에 담아두신 상품",
    "body": "재고가 얼마 남지 않았어요",
    "deep_link": "myapp://cart"
  }'
```

> 발송 API 는 큐에 넣고 즉시 `202` 로 응답합니다. 실제 fan-out 은 워커가 처리합니다 — 수집과 전송을 분리해, 대량 발송이 API 응답을 붙잡지 않게 한 구조입니다.
