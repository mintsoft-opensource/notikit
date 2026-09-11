---
title: 토큰 수명 관리
---

# 토큰 수명 관리

FCM 토큰은 갱신됩니다. 새 토큰으로 그냥 등록하면 **행이 하나 더 생겨 같은 사람에게 중복 발송**됩니다. 반드시 교체 API 를 쓰세요.

```bash
curl -X POST https://push.example.com/api/v1/devices/rotate \
  -H "content-type: application/json" \
  -H "api-key: nk_xxx" \
  -d '{
    "old_token": "<이전 토큰>",
    "new_token": "<새 토큰>",
    "identity_hash": "<유저 바인딩된 기기면 필수>"
  }'
```

교체는 기존 기기 행의 토큰을 제자리 갱신하므로 **기기 id·토픽 구독·클릭 이력·수신거부가 모두 보존**됩니다.

## 앱 삭제 감지

앱 삭제는 직접 알 수 없습니다. 워커가 매일 새벽 FCM dry-run(검증 전용, 유저에게 아무것도 보이지 않음)으로 전체 토큰을 점검해 죽은 토큰을 비활성 처리하고 "설치/삭제" 통계에 기록합니다.
