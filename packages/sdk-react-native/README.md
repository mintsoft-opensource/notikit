# @notikit/react-native

> Notikit React Native SDK — 디바이스 등록 + identity (`@notikit/core` 기반).

## 설치
```bash
npm install @notikit/react-native @react-native-firebase/messaging
```

## 사용
```ts
import messaging from "@react-native-firebase/messaging";
import { NotikitReactNative } from "@notikit/react-native";

const notikit = new NotikitReactNative({
  baseUrl: "https://push.example.com",
  apiKey: "nk_xxx",          // 공개키만 (secret 미포함)
  identityHash: "<서버계산 HMAC>", // user id 바인딩 시
});

await messaging().requestPermission();
const token = await messaging().getToken();
await notikit.register(token, Platform.OS === "ios" ? "ios" : "android", "user-123");
```

## 수신(도달) 추적

발송 성공(FCM 접수)은 기기가 꺼져 있어도, 앱이 지워져 있어도 성공합니다 — 도달이 아닙니다.
앱이 수신을 보고하지 않으면 콘솔의 "도달" 칸은 계속 비어 있습니다.

백그라운드 핸들러에 그대로 꽂으세요. **앱 진입점(`index.js`)에서 등록해야** 앱이 꺼져
있을 때도 불립니다.

```ts
// index.js — AppRegistry 등록 전
messaging().setBackgroundMessageHandler(notikit.backgroundMessageHandler(token));

// 포그라운드에서도 같은 발송이 도달입니다
messaging().onMessage(async (m) => {
  const { logId } = readPushData(m.data);
  if (logId) await notikit.reportReceived(token, logId);
});
```

`backgroundMessageHandler` 는 **절대 throw 하지 않습니다** — 백그라운드 핸들러가 실패하면
안드로이드가 헤드리스 작업을 실패로 적고 iOS 가 다음 실행 예산을 깎습니다. notikit 발송이
아니면(`notikit_log_id` 없음) 아무것도 하지 않습니다. 재배달로 다시 불려도 같은 발송이면
요청을 내보내지 않습니다.

## API
| | 설명 |
|---|---|
| `register(fcmToken, platform, userId?)` | FCM 토큰 등록 (+ 유저 연결) |
| `identify(userId, attributes?, name?)` | 유저 식별 |
| `subscribe(topic, fcmToken)` | 토픽 구독 |
| `reportReceived(fcmToken, messageId)` | 수신(도달) 보고. 이미 보고한 발송이면 `null` |
| `backgroundMessageHandler(fcmToken)` | `setBackgroundMessageHandler` 에 넣을 핸들러 |

`userId` 는 고객 서비스의 유저 id 이며 서버에 `user_id` 로 보냅니다. 위치 인자라 기존 호출은 그대로 동작합니다.
`core` 의 입력 객체에서도 이전 이름 `externalId`(`external_id`)가 그대로 동작하지만 deprecated 입니다.

## 라이선스
Apache-2.0
