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

## API
| | 설명 |
|---|---|
| `register(fcmToken, platform, userId?)` | FCM 토큰 등록 (+ 유저 연결) |
| `identify(userId, attributes?, name?)` | 유저 식별 |
| `subscribe(topic, fcmToken)` | 토픽 구독 |

`userId` 는 고객 서비스의 유저 id 이며 서버에 `user_id` 로 보냅니다. 위치 인자라 기존 호출은 그대로 동작합니다.
`core` 의 입력 객체에서도 이전 이름 `externalId`(`external_id`)가 그대로 동작하지만 deprecated 입니다.

## 라이선스
Apache-2.0
