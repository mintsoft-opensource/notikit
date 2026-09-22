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
await notikit.registerDevice({ token, platform: "android", externalId: "user-123" });

// 유저 식별 (identity)
await notikit.identify({ externalId: "user-123", attributes: { plan: "pro" } });

// 토픽 구독
await notikit.subscribe("news", token);

// 푸시 전송 (보통 백엔드에서)
await notikit.send({ title: "안녕", body: "본문", type: "single", target: "user-123", deepLink: "https://app/orders/1" });
```

## API
| 메서드 | 설명 |
|---|---|
| `registerDevice(input)` | 토큰 등록·업서트 |
| `identify(input)` | 유저 식별/속성 |
| `subscribe(topic, token)` | 토픽 구독 |
| `send(input)` | 푸시 전송(큐잉). `template`·`fields` 로 콘솔 템플릿 사용, `type: "multi"` + `targets` 로 여러 명 |
| `unsubscribe(topic, target)` | 토픽 구독 해지 |
| `readPushData(data)` | 받은 푸시에서 `{ logId, deepLink, custom }` — `custom` 은 커스텀 필드만 |

```ts
// 서버: 콘솔 템플릿 이름으로 발송
await notikit.send({ type: "single", target: "u-42", template: "주문 도착", fields: { order_id: "A-1024" } });

// 앱(RN·웹): 받은 푸시에서 커스텀 필드 읽기
const { custom, deepLink } = readPushData(remoteMessage.data);
```

- `fetch` 를 주입하면 RN/Node 커스텀 환경에서도 동작합니다.
- 에러는 `NotikitError`(status 포함)로 throw.

## 라이선스
Apache-2.0
