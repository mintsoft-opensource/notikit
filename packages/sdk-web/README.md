# @notikit/web-sdk

> Notikit Web SDK — 브라우저 Web Push (서비스워커 + VAPID).

## 설치
```bash
npm install @notikit/web-sdk
```

## 1) 서비스워커 배치
`public/notikit-sw.js` 로 아래 내용을 호스팅하세요 (또는 SDK 의 `NOTIKIT_SERVICE_WORKER` 문자열을 파일로 저장):
```js
self.addEventListener("push", (e) => {
  const p = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(p.title || "알림", {
    body: p.body, data: { deep_link: (p.data && p.data.deep_link) || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.deep_link || "/"));
});
```

## 2) 등록
```ts
import { NotikitWeb } from "@notikit/web-sdk";

const notikit = new NotikitWeb({
  baseUrl: "https://push.example.com",
  apiKey: "nk_xxx",
  vapidPublicKey: "BÖ...", // 서버 발급 VAPID 공개키
  externalId: "user-123",
});

if (NotikitWeb.isSupported()) {
  await notikit.register(); // 권한 요청 → 구독 → 서버 등록
}
```

> iOS Safari 는 홈화면에 추가한 PWA 에서만 Web Push 동작(16.4+).

## 라이선스
Apache-2.0
