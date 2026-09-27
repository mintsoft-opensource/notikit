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
| `reportReceived({ logId, token })` | 수신(도달) 보고. 이미 보고한 발송이면 요청 없이 `null` |
| `readPushData(data)` | 받은 푸시에서 `{ logId, deepLink, custom }` — `custom` 은 커스텀 필드만 |

### 수신(도달) 보고

발송 성공은 **FCM 이 접수했다**는 뜻입니다 — 기기가 꺼져 있어도, 앱이 지워져 있어도
성공합니다. 단말이 실제로 받았는지는 앱이 알려 줘야 하고, 알려 주지 않으면 콘솔의 "도달"
칸은 계속 비어 있습니다.

알림을 **받은 순간** 부르세요(클릭과 달리 사용자가 누르지 않아도 일어나야 합니다).
RN 은 백그라운드 메시지 핸들러, 웹은 서비스워커의 `push` 이벤트입니다 — 두 플랫폼 SDK 는
이미 그 자리에서 부르고 있으므로 직접 부를 일은 서버·커스텀 런타임뿐입니다.

```ts
const { logId } = readPushData(remoteMessage.data);
if (logId) await notikit.reportReceived({ logId, token });
```

같은 발송을 두 번 이상 부르면 **요청을 내보내지 않고** `null` 입니다(클라이언트 한 벌당
최근 200건 기억). 재배달·재시도로 다시 불려도 안전하며, 서버도 `(발송, 기기)` 유니크로
한 번만 셉니다. 다시 시도할 가치가 없는 실패(4xx)는 기억을 유지하고, 네트워크 장애·5xx·429
만 풀어 줍니다.

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
