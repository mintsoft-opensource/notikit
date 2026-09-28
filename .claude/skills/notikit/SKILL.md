---
name: notikit
description: Notikit(유저 중심 셀프호스트 푸시)를 앱/웹에 통합. 프로젝트 생성, SDK 연동(web/react/react-native/flutter/android/swift), identity 검증, 딥링크, 발송까지 안내.
---

# Notikit 통합 스킬

유저 중심 푸시 인프라 **Notikit** 을 앱에 붙일 때 이 절차를 따른다.

## 0. MCP 우선
`@notikit/mcp` 가 연결돼 있으면 도구로 처리한다:
- `create_project` → api-key/secret 발급
- `get_integration_snippet(platform, api_key)` → 실제 키가 채워진 코드 (그대로 삽입)
- `send_test_push(...)` → 수신 검증
MCP 가 없으면 아래 수동 절차.

## 1. 인증 모델 (중요)
- **api-key = 공개키**: 클라이언트 SDK(앱/웹)에 넣어도 됨. 등록/식별/구독만 가능.
- **api-secret = 서버 전용**: 발송(`/messages`)에만 필요. **앱에 절대 포함 금지.**
- **identity_hash**: `external_id` 로 유저를 바인딩할 때 필수. 고객 **서버**가 `HMAC-SHA256(external_id, api_secret)` 계산해 클라이언트에 내려준다(사칭 방지).

## 2. SDK 선택 & 설치
| 플랫폼 | 패키지 |
|---|---|
| 웹(바닐라) | `@mint-soft/notikit-web` |
| React/Next | `@mint-soft/notikit-react` |
| React Native | `@mint-soft/notikit-react-native` + `@react-native-firebase/messaging` |
| Flutter | `notikit` + `firebase_messaging` |
| Android | `dev.notikit:notikit` + Firebase Messaging |
| iOS | Swift `Notikit` (SPM/CocoaPods) |

## 3. 표준 연동 흐름
1. FCM/APNs/Web Push 토큰 획득 (플랫폼 SDK)
2. `registerDevice(token, platform, externalId?, identityHash?)` — 등록(+유저 연결)
3. 필요 시 `identify(externalId, attributes)` — 세그먼트용 속성
4. `subscribe(topic, token)` — 토픽
5. 서버에서 `POST /api/v1/messages` (api-key+secret) 로 발송

## 4. 딥링크
발송 payload 의 `deep_link` 를 앱이 읽어 화면 라우팅. iOS Universal Links(AASA) + Android App Links(assetlinks.json) 설정. OneLink/FDL 불필요(푸시는 이미 설치된 유저).

## 5. 검증
- 등록 후 대시보드/`list_devices` 로 확인
- `send_test_push` 또는 발송 API → 실기기 수신 확인
- Firebase 미구성이면 서버가 **log-only** 로 기록(개발 중 안전)

## 참고
- API 문서: `${BASE_URL}/docs` (Swagger) · OpenAPI: `/api/openapi.json`
- 테스터: `${BASE_URL}/tester`
