# @notikit/web-sdk

> Notikit Web SDK — 브라우저 푸시 (FCM / Firebase Cloud Messaging).

토큰은 **FCM 등록 토큰**입니다. 서버는 안드로이드·iOS 와 같은 경로로 발송하므로 웹 전용
전송 분기가 필요 없습니다.

## 설치
```bash
npm install @notikit/web-sdk firebase
```

`firebase` 는 peer dependency 입니다(선택). `getToken` 을 직접 넘기면 설치하지 않아도 됩니다.

## 1) 서비스워커 배치

`public/notikit-sw.js` 로 SDK 의 `NOTIKIT_SERVICE_WORKER` 문자열을 그대로 저장하세요.

```ts
import { NOTIKIT_SERVICE_WORKER } from "@notikit/web-sdk";
// 빌드 스크립트에서: fs.writeFileSync("public/notikit-sw.js", NOTIKIT_SERVICE_WORKER)
```

워커는 설정을 **자기 URL 쿼리에서만** 읽습니다(워커에는 SDK 인스턴스가 없습니다).
`register()` 가 쿼리를 자동으로 붙이므로 경로만 맞추면 됩니다.

## 2) 등록

`firebase` 설정은 **항상 필요합니다.** 워커에는 앱의 Firebase 인스턴스가 없어서, 이 값으로
직접 초기화해야 백그라운드 메시지를 받습니다.

```ts
import { NotikitWeb } from "@notikit/web-sdk";

const notikit = new NotikitWeb({
  baseUrl: "https://push.example.com",
  apiKey: "nk_xxx",
  vapidPublicKey: "B...",   // Firebase 콘솔 > 클라우드 메시징 > 웹 푸시 인증서
  externalId: "user-123",
  firebase: {
    apiKey: "AIza...",
    projectId: "my-project",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abc",
  },
  // 워커가 불러올 compat SDK 버전. 설치한 firebase 와 메이저를 맞추세요.
  firebaseSdkVersion: "12.0.0",
});

if (NotikitWeb.isSupported()) {
  await notikit.register(); // 권한 요청 → FCM 토큰 → 서버 등록
}
```

이미 Firebase 를 초기화한 앱이라면 **토큰 획득만** 넘겨받게 할 수 있습니다 — SDK 가
`initializeApp` 을 또 부르면 앱이 쓰던 인스턴스와 어긋납니다. (`firebase` 설정은 그래도
워커용으로 함께 넘겨야 합니다.)

```ts
import { getMessaging, getToken } from "firebase/messaging";

const notikit = new NotikitWeb({
  /* ...위와 동일... */
  getToken: (reg) =>
    getToken(getMessaging(myFirebaseApp), { vapidKey: "B...", serviceWorkerRegistration: reg }),
});
```

## 3) 토큰 교체

FCM 은 토큰을 갱신합니다. 새 토큰으로 `register()` 를 다시 부르면 **행이 하나 더 생겨**
같은 사람에게 중복 발송됩니다. 교체는 전용 메서드를 쓰세요 — 서버가 기존 행을 제자리
갱신해 토픽 구독·클릭 이력이 보존됩니다.

```ts
await notikit.rotateToken(oldToken, newToken);
```

## 클릭 추적

워커가 `notificationclick` 에서 자동으로 보고합니다. 보고에 쓸 FCM 토큰은 등록 시점에
IndexedDB 에 저장된 값을 읽습니다 — 워커에서는 `getToken` 을 부를 수 없기 때문입니다.

> iOS Safari 는 홈화면에 추가한 PWA 에서만 웹 푸시가 동작합니다(16.4+).

## 라이선스
Apache-2.0
