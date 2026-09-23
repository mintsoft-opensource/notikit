# @notikit/react

> Notikit React SDK — Web SDK 위의 hooks (Next.js 호환).

## 설치
```bash
npm install @notikit/react
```

## 사용
```tsx
"use client";
import { NotikitProvider, usePushRegistration } from "@notikit/react";

function PushButton() {
  const { status, register, error } = usePushRegistration();
  return (
    <button onClick={register} disabled={status === "registering"}>
      {status === "registered" ? "알림 켜짐 ✓" : "알림 받기"}
      {error && <span> — {error}</span>}
    </button>
  );
}

export default function App() {
  return (
    <NotikitProvider
      config={{
        baseUrl: "https://push.example.com",
        apiKey: "nk_xxx",
        vapidPublicKey: "BÖ...",
        userId: "user-123", // 고객 서비스의 유저 id (서버에는 user_id 로 전송)
      }}
    >
      <PushButton />
    </NotikitProvider>
  );
}
```

## API
| | 설명 |
|---|---|
| `<NotikitProvider config>` | 컨텍스트 제공 |
| `useNotikit()` | `NotikitWeb` 인스턴스 |
| `usePushRegistration()` | `{ status, token, error, register }` |

`config` 는 `@notikit/web-sdk` 의 `NotikitWebConfig` 입니다. 이전 이름 `externalId`(`external_id`)도 그대로
동작하지만 deprecated 입니다 — `userId` 를 쓰세요.

## 라이선스
Apache-2.0
