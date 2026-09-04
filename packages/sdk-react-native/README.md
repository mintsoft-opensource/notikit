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
  identityHash: "<서버계산 HMAC>", // external_id 바인딩 시
});

await messaging().requestPermission();
const token = await messaging().getToken();
await notikit.register(token, Platform.OS === "ios" ? "ios" : "android", "user-123");
```

## API
| | 설명 |
|---|---|
| `register(fcmToken, platform, externalId?)` | FCM 토큰 등록 |
| `identify(externalId, attributes?)` | 유저 식별 |
| `subscribe(topic, fcmToken)` | 토픽 구독 |

## 라이선스
Apache-2.0
