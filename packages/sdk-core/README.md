# @notikit/core

> Notikit SDK 코어 — 타입 안전 API 클라이언트 (브라우저 / Node / React Native 공용).

모든 Notikit 플랫폼 SDK 가 공유하는 HTTP 계층입니다.

## 설치
```bash
npm install @notikit/core
# 또는
pnpm add @notikit/core
yarn add @notikit/core
```

## 사용
```ts
import { NotikitClient } from "@notikit/core";

const notikit = new NotikitClient({
  baseUrl: "https://push.example.com",
  apiKey: "nk_xxx",
  apiSecret: "sk_xxx", // 선택 (spring 호환이면 생략)
});

// 디바이스/토큰 등록 (+ 유저 연결)
await notikit.registerDevice({ token, platform: "android", userId: "user-123" });

// 유저 식별 (identity)
await notikit.identify({ userId: "user-123", attributes: { plan: "pro" } });

// 토픽 구독 — 토큰(기기 하나) 또는 유저(그 사람의 활성 기기 전부)
await notikit.subscribe("news", token);
await notikit.subscribe("vip", { userId: "user-123", identityHash });

// 푸시 전송 (보통 백엔드에서)
await notikit.send({ title: "안녕", body: "본문", type: "single", target: "user-123", deepLink: "https://app/orders/1" });
```

> `userId` 는 고객 서비스의 유저 id 이며 서버에 `user_id` 로 보냅니다. 이전 이름 `externalId`(`external_id`)도
> 모든 입력에서 그대로 동작하지만 deprecated 입니다 — 둘 다 주면 `userId` 가 이깁니다.
> `NotikitSession.login({ userId })` 도 마찬가지이며, 이전 버전이 저장한 유저도 그대로 읽습니다.

## API
| 메서드 | 설명 |
|---|---|
| `registerDevice(input)` | 토큰 등록·업서트 |
| `identify(input)` | 유저 식별/속성 |
| `subscribe(topic, target)` | 토픽 구독 (`token` 또는 `{ userId, identityHash }`) |
| `send(input)` | 푸시 전송(큐잉). `template`·`fields` 로 콘솔 템플릿 사용, `type: "multi"` + `targets` 로 여러 명, `scheduledAt`·`variants`·`kakaoFallback`·`idempotencyKey` 선택 |
| `unsubscribe(topic, target)` | 토픽 구독 해지 |
| `readPushData(data)` | 받은 푸시에서 `{ logId, deepLink, custom }` — `custom` 은 커스텀 필드만 |

```ts
// 서버: 콘솔 템플릿 이름으로 발송
await notikit.send({ type: "single", target: "u-42", template: "주문 도착", fields: { order_id: "A-1024" } });

// 서버: 예약 + A/B 변형 + 알림톡 대체 + 중복 방지 키
await notikit.send({
  type: "topic",
  target: "vip",
  title: "주말 특가",
  body: "지금 확인하세요",
  scheduledAt: new Date("2026-10-03T09:00:00+09:00"), // → scheduled_at (ISO 8601)
  variants: [
    { title: "주말 특가", body: "지금 확인하세요" },
    { title: "이번 주말만", body: "최대 50% 할인" },
  ], // 2~5개
  kakaoFallback: true, // → kakao_fallback
  idempotencyKey: "promo-2026-10-03", // → Idempotency-Key 헤더
});

// 앱(RN·웹): 받은 푸시에서 커스텀 필드 읽기
const { custom, deepLink } = readPushData(remoteMessage.data);
```

- `fetch` 를 주입하면 RN/Node 커스텀 환경에서도 동작합니다.
- 에러는 `NotikitError`(status 포함)로 throw.

## 라이선스
Apache-2.0
