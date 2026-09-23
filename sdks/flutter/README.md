# notikit (Flutter)

> Notikit Flutter SDK — 유저 중심 푸시 디바이스 등록/식별.

## 설치
```yaml
dependencies:
  notikit: ^0.1.0
  firebase_messaging: ^15.0.0
```

## 사용
```dart
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:notikit/notikit.dart';

final notikit = Notikit(
  baseUrl: 'https://push.example.com',
  apiKey: 'nk_xxx', // 공개키만
);

await FirebaseMessaging.instance.requestPermission();
final token = await FirebaseMessaging.instance.getToken();
await notikit.registerDevice(
  token: token!,
  platform: Platform.isIOS ? 'ios' : 'android',
  userId: 'user-123', // 고객 서비스의 유저 id
  identityHash: '<서버계산 HMAC>',
);
```

## API
| | 설명 |
|---|---|
| `registerDevice(...)` | FCM 토큰 등록 |
| `identify(userId: ...)` | 유저 식별 |
| `subscribe(topic, token)` | 토픽 구독 |
| `unsubscribe(topic, token)` | 토픽 구독 해지 |
| `Notikit.customDataFromPayload(message.data)` | 받은 푸시에서 커스텀 필드(템플릿 필드 포함)만 꺼내기 |
| `Notikit.deepLinkFromPayload(message.data)` | 받은 푸시의 딥링크 |

> `externalId` 파라미터(서버 필드 `external_id`)도 계속 동작하지만 deprecated 다 — `userId` 를 쓴다. SDK 는 항상 `user_id` 로 전송한다.

## 라이선스
Apache-2.0
