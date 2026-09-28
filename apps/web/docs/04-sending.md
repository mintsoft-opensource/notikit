---
title: 발송
---

# 발송

| 타입 | target | 대상 |
|---|---|---|
| `single` | user_id | 그 유저의 활성 디바이스 전체 |
| `multi` | `targets`: user_id 배열 (최대 1000) | 목록에 있는 유저들의 활성 디바이스 전체 |
| `topic` | 토픽 이름 | 그 토픽에 속한 디바이스 전체 |
| `broadcast` | 불필요 | 프로젝트의 활성 디바이스 전체 |

> `segment` 타입도 계속 받습니다. 세그먼트가 토픽으로 합쳐지기 전에 쓰던 이름이고, 지금은 `topic` 과 똑같이 동작합니다. 새로 연동한다면 `topic` 을 쓰세요.

`multi` 는 `target` 대신 `targets` 배열을 받습니다. 중복은 합쳐지고, 등록되지 않은 아이디는 건너뜁니다(에러가 아닙니다). 1000명을 넘는 묶음이라면 토픽을 쓰는 편이 맞습니다.

```json
{ "type": "multi", "targets": ["u-1", "u-2", "u-3"], "title": "주문이 도착했어요", "body": "지금 확인해 보세요" }
```

## 치환 — 받는 사람마다 다른 문구

제목·본문에 `{{변수}}` 를 쓰면 받는 사람마다 다른 값으로 바뀝니다. 기본 변수가 먼저이고, 그 밖의 이름은 `identify` 로 보낸 **유저 속성**에서 찾습니다.

| 변수 | 값 |
|---|---|
| `{{name}}` | 사용자 이름 — `identify` 의 `name`. 없으면 `attributes.name` |
| `{{user_id}}` | 사용자 아이디 |
| `{{app_name}}` | 프로젝트 이름 |
| `{{date}}` | 받는 날짜 (받는 사람의 시간대·언어, 예: `9월 22일`) |
| `{{time}}` | 받는 시각 (예: `오후 3:30`) |
| `{{weekday}}` | 요일 (예: `화요일`) |
| `{{plan}}` 등 | `attributes` 의 같은 이름 값 |
| `{{name\|고객}}` | 값이 없거나 빈 문자열이면 `고객` |

이름은 `identify` 로 보냅니다. 앱 SDK 는 모두 `name` 을 받습니다(`identify(..., name)`).

```json
POST /api/v1/users/identify
{ "user_id": "u-42", "name": "김민지", "timezone": "Asia/Seoul", "locale": "ko", "attributes": { "plan": "pro" } }
```

날짜·시각은 `identify` 의 `timezone`·`locale` 을 씁니다. 없으면 UTC·한국어로 표시합니다.

```json
{ "type": "topic", "target": "vip", "title": "{{name|고객}}님, VIP 전용 혜택", "body": "{{plan}} 요금제 회원만 받는 쿠폰이에요" }
```

값도 기본값도 없으면 빈칸이 됩니다(중괄호를 그대로 보여 주지 않습니다). 유저에 묶이지 않은 익명 기기는 속성이 없으므로 기본값을 쓰는 것이 안전합니다. A/B 변형 문구와 인박스에도 똑같이 적용됩니다.

> 치환이 있으면 받는 사람마다 내용이 달라져 한 번에 묶어 보내는 양이 줄어듭니다. 수십만 명 규모의 토픽이라면 발송 시간이 늘어날 수 있습니다.

## 커스텀 필드와 템플릿

알림에 앱이 읽을 값을 함께 실으려면 `data` 에 넣습니다(문자열 값, 최대 8KB). 앱에서는 푸시 페이로드의 data 로 받습니다.

```json
{ "type": "single", "target": "u-42", "title": "주문이 도착했어요", "body": "확인해 보세요", "data": { "order_id": "A-1024", "screen": "order_detail" } }
```

`deep_link`, `notikit_log_id`, `title`, `body`, `icon`, `from`, `notification`, `message_type`, `collapse_key` 와 `google.`·`gcm.` 로 시작하는 키는 쓸 수 없습니다. 딥링크·클릭 추적·웹 알림이 쓰는 키이거나 FCM 이 예약한 키입니다.

콘솔의 **발송 → 템플릿** 에서 제목·본문·딥링크와 커스텀 필드(키·표시 이름·기본값·필수 여부)를 묶어 저장할 수 있습니다. 발송 화면에서 템플릿을 고르면 내용이 채워지고 필드마다 입력칸이 생기며, 입력한 값이 `data` 로 나갑니다. ### API 에서 템플릿으로 보내기

`template` 에 템플릿 **이름**을, `fields` 에 커스텀 필드 값을 넣습니다. 문구는 콘솔에서 고치고, 서버 코드는 이름만 부르면 됩니다.

```bash
curl -X POST https://<notikit>/api/v1/messages \
  -H "api-key: nk_..." -H "api-secret: sk_..." -H "content-type: application/json" \
  -d '{ "type": "single", "target": "u-42", "template": "주문 도착", "fields": { "order_id": "A-1024" } }'
```

```ts
// @mint-soft/notikit-core (서버)
await notikit.send({ type: "single", target: "u-42", template: "주문 도착", fields: { order_id: "A-1024" } });
```

| 상황 | 결과 |
|---|---|
| 요청에 `title`·`body`·`deep_link`·`data` 도 줌 | 요청 값이 템플릿보다 우선 |
| `fields` 에 없는 필드 | 템플릿 기본값, 기본값도 없으면 뺌 |
| 필수 필드 누락 · 템플릿에 없는 키 | 422 |
| 없는 템플릿 이름 | 404 |

> 템플릿 이름을 바꾸면 옛 이름으로 부르는 요청은 404 가 됩니다. 콘솔 편집 화면에서도 경고합니다.

### 앱에서 커스텀 필드 읽기

앱 SDK 는 받은 푸시에서 notikit·FCM 이 쓰는 키를 빼고 커스텀 필드만 돌려주는 도우미를 제공합니다. 값은 항상 문자열입니다.

| SDK | 호출 |
|---|---|
| Android | `Notikit.customDataFromPayload(remoteMessage.data)` |
| iOS | `Notikit.customData(fromPayload: response.notification.request.content.userInfo)` |
| Flutter | `Notikit.customDataFromPayload(message.data)` |
| React Native · Web | `readPushData(data).custom` (`@mint-soft/notikit-core` 에서도 export) |

앱에서 발송하는 기능은 없습니다. 발송에는 `api-secret` 이 필요한데, 앱에 넣으면 누구나 꺼내 푸시를 보낼 수 있기 때문입니다. 발송은 서버에서 하세요.

## 토픽 — 명단을 채우는 두 가지 방식

토픽은 "이름 붙인 수신자 묶음"입니다. 명단을 채우는 방법이 두 가지이고, **발송하는 쪽에서는 차이가 없습니다** — 둘 다 `type: "topic"` 에 이름만 주면 됩니다.

| 방식 | 명단이 정해지는 시점 | 쓰는 곳 |
|---|---|---|
| **구독식** | 구독 API 를 부를 때 (`subscriptions` 에 저장) | 유저가 직접 켜는 것 — "야구 소식", "할인 알림" |
| **규칙식** | **발송할 때마다 다시 계산** | 회사가 아는 값 — 등급, 요금제, 가입연도 |

구독식은 유저의 수신 동의를 담습니다. 규칙식은 `identify` 로 보낸 **유저 속성**에 조건을 겁니다.

```jsonc
// 규칙식 토픽 (콘솔 또는 관리 API 에서 생성)
{ "name": "vip", "rules": [{ "attribute": "grade", "value": "vip" }] }
```

규칙은 AND 로 묶이고, 값은 **문자열 동등 비교**입니다. 조건은 최대 20개이며 **0개는 허용하지 않습니다** — 조건이 없으면 전원이 대상이 되어 `broadcast` 와 같아지기 때문입니다.

규칙식 토픽은 구독 API 로 넣고 뺄 수 없습니다(409). 명단이 자동으로 정해지는데 손으로도 넣을 수 있으면, 누가 왜 받았는지 설명할 수 없게 됩니다.

## 토픽 구독·해지

```jsonc
POST /api/v1/topics/subscribe     { "topic": "news", "token": "..." }
POST /api/v1/topics/unsubscribe   { "topic": "news", "token": "..." }
```

`token` 대신 `user_id` 를 주면 **그 사람의 활성 디바이스 전부**가 한 번에 처리됩니다. 백엔드에서 "이 사람을 vip 에 넣어줘" 할 때 쓰면 기기 목록을 따로 관리하지 않아도 됩니다. 둘 중 **정확히 하나**만 보내야 합니다(둘 다 보내면 422).

`user_id` 를 쓸 때는 `identity_hash`(= HMAC-SHA256(user_id, api_secret))가 **항상 필수**입니다(없거나 틀리면 403). 공개 api-key 만으로 남의 기기를 넣고 빼지 못하게 하기 위해서입니다.

```jsonc
POST /api/v1/topics/subscribe     { "topic": "vip", "user_id": "u-42", "identity_hash": "..." }
```

응답의 `added`/`removed` 로 실제로 몇 건이 바뀌었는지 확인할 수 있습니다.

구독은 없는 토픽을 자동으로 만들지만, **해지는 만들지 않습니다** — 없으면 404 입니다.

## 이미지

`image_url` 에 https 이미지 주소를 넣으면 알림에 큰 이미지가 붙습니다(최대 2048자). http 주소는 422 로 거절합니다 — iOS 와 브라우저가 http 이미지를 내려받지 않아 이미지 없는 알림이 나가기 때문입니다.

```json
{ "type": "topic", "target": "news", "title": "신상품 입고", "body": "지금 확인해 보세요", "image_url": "https://cdn.example.com/p/1.jpg" }
```

- Android: 그대로 표시됩니다.
- iOS: `mutable-content: 1` 로 보내므로 앱에 **Notification Service Extension** 이 있어야 이미지가 붙습니다(없으면 글자만 표시).
- 웹: 서비스 워커가 알림의 `image` 로 그립니다. 앱에서는 `data.image` 로도 읽을 수 있습니다.

## 알림 옵션

`options` 에 알림음·배지·유효기간·액션 버튼 같은 표시 방식을 넣습니다. 서버가 플랫폼별 제자리에 나눠 싣습니다.

| 키 | 값 | Android | iOS(APNs) | 웹 |
|---|---|---|---|---|
| `sound` | 파일명 또는 `"default"` | `notification.sound` | `aps.sound` | — |
| `badge` | 0 이상 정수 | — | `aps.badge` | — |
| `collapse_key` | 64자 이내 | `collapse_key` | `apns-collapse-id` | — |
| `android_channel_id` | 64자 이내 | `notification.channel_id` | — | — |
| `ios_thread_id` | 64자 이내 | — | `aps.thread-id` | — |
| `ttl_seconds` | 0 ~ 2419200(28일) | `ttl` | `apns-expiration` | — |
| `priority` | `high`(기본) · `normal` | `priority` | `normal` 이면 `apns-priority: 5` | — |
| `silent` | 불리언 | 알림 없이 data 만 | `content-available` | 알림 없이 data 만 |
| `actions` | 최대 3개 `{ id, title, deep_link? }` | `data.actions` | `data.actions` | `data.actions` |

```json
{
  "type": "topic", "target": "news", "title": "장바구니가 기다려요", "body": "지금 결제하면 10% 할인",
  "options": {
    "sound": "default", "badge": 1, "collapse_key": "cart", "ttl_seconds": 3600,
    "actions": [{ "id": "checkout", "title": "결제하기", "deep_link": "https://shop.example.com/cart" }]
  }
}
```

- `ttl_seconds: 0` 은 "지금 못 받는 기기에는 버린다"는 뜻입니다. 실시간 알림에만 쓰세요.
- `collapse_key` 를 같게 주면 기기에 알림이 하나만 남습니다(최신 것으로 덮어씀).
- `silent: true` 면 알림을 그리지 않고 `data` 만 갑니다. 이때는 **제목·본문이 없어도 됩니다**. 무음 푸시는 iOS 에서 자동으로 `apns-priority: 5` 로 나갑니다(우선순위 10 이면 APNs 가 거절합니다).
- 액션 버튼은 `data.actions` 에 JSON 문자열로 실립니다. 앱 SDK 에서는 `readPushData(data).actions` 로 읽어 버튼을 그리고, 누른 버튼의 `id` 로 분기하세요. 버튼을 그리는 것은 앱(또는 웹 서비스워커)의 몫입니다.
- `options` 도 4KB 검사에 포함됩니다. 액션 버튼을 많이 붙이면 본문을 줄여야 할 수 있습니다.

## 전환 측정

알림을 누른 뒤 앱에서 일어난 행동(구매·가입 등)을 발송 성과로 남깁니다.

```jsonc
POST /api/v1/events
{ "name": "purchase", "value_cents": 19900, "token": "<이 기기의 푸시 토큰>" }
```

`token` 대신 `user_id` + `identity_hash` 로도 보낼 수 있습니다(둘 중 **정확히 하나**). 공개 api-key 만 있으면 되므로 앱에서 직접 부릅니다.

```ts
// @mint-soft/notikit-core · React Native · Web SDK
await notikit.trackConversion("purchase", 19900);
```

| 규칙 | 내용 |
|---|---|
| 귀속 대상 | 그 기기(또는 그 사람)가 **최근 24시간 안에 클릭한 마지막 발송** |
| 클릭이 없으면 | 저장하지 않고 `202 { "attributed": false }` — 오류가 아닙니다 |
| 중복 | 같은 날 같은 (발송, 사람, 이름)은 1건. 재시도해도 매출이 부풀지 않습니다 |
| 금액 | `value_cents` 는 최소 화폐 단위(원화면 원)의 정수. 금액 없는 전환은 생략 |

귀속은 **보고하는 순간에 끝납니다**. 나중에 다시 계산하지 않으므로 클릭 기록이 정리돼도 과거 성과가 흔들리지 않습니다.

## 예약 발송

`scheduled_at` 에 ISO 8601 시각을 넣습니다. 과거 시각이면 즉시 발송으로 처리됩니다.

```json
{
  "type": "topic",
  "target": "news",
  "title": "주간 소식",
  "body": "이번 주 인기 글을 모았어요",
  "scheduled_at": "2026-03-02T09:00:00+09:00"
}
```

> `scheduled_at` 을 주지 않으면 프로젝트의 **방해금지 시간대** 규칙이 적용됩니다. 조용한 시간에 걸리면 서버가 자동으로 그 이후로 미룹니다 — 즉시 나가야 하는 알림이라면 방해금지 설정을 확인하세요.

## 받는 사람 현지 시각 발송

`local_time` 에 `"HH:MM"` 을 주면 **각자 현지 시각**으로 그 시각에 보냅니다. "전 세계 사용자에게 각자 아침 9시" 같은 발송입니다.

```json
{ "type": "broadcast", "title": "오늘의 소식", "body": "아침에 확인해 보세요", "local_time": "09:00" }
```

| 규칙 | 내용 |
|---|---|
| 시간대 기준 | `identify` 의 `timezone` → 기기 등록값 → 프로젝트 시간대 → UTC 순 |
| 묶는 단위 | 같은 UTC 오프셋끼리. 시각이 된 묶음부터 나가고, 아직인 묶음은 그 시각에 이어서 나갑니다 |
| 하루 창 | 걸어 둔 지 24시간이 지나면 남은 묶음도 즉시 보냅니다 |
| 함께 적용되는 것 | 방해금지 시간대·빈도 상한·`scheduled_at` — 건너뛰지 않습니다 |
| 테스트 발송 | `test: true` 면 무시하고 즉시 보냅니다 |

발송 한 건의 상태는 모든 묶음이 나갈 때까지 `processing` 으로 남습니다(로그는 1행 그대로입니다).

## A/B 자동 승자

변형(`variants`)에 `ab_test` 를 붙이면 **표본에게 먼저 보내고**, 정한 시간이 지난 뒤 **유니크 클릭률**이 가장 좋은 변형을 나머지에게 한 번 더 보냅니다. 두 번째 발송은 로그 1행으로 따로 남습니다.

```json
{
  "type": "broadcast",
  "title": "A 제목", "body": "A 본문",
  "variants": [{ "title": "A 제목", "body": "A 본문" }, { "title": "B 제목", "body": "B 본문" }],
  "ab_test": { "sample_percent": 20, "wait_minutes": 120 }
}
```

| 규칙 | 내용 |
|---|---|
| 표본과 나머지 | 토큰 해시의 **버킷**으로 가릅니다. 표본에 들어간 기기는 정의상 승자 발송 대상이 아니라, 한 사람이 같은 내용을 두 번 받지 않습니다 |
| 지표 | 유니크 클릭률(변형별 유니크 클릭 ÷ 변형별 도달) 고정입니다 |
| 최소 표본 | 변형마다 도달 **100건** 이상. 못 채우면 승자를 선언하지 않습니다 |
| 동률 | 1·2위 클릭률 차이가 **1%p 미만**이면 승자를 선언하지 않습니다 |
| 승자가 없으면 | 본발송을 만들지 않고 **이유**(표본 부족·동률·클릭 없음)를 로그에 남깁니다. 조용히 A 를 고르지 않습니다 |
| 쓸 수 없는 곳 | `variants` 가 없거나 `type=single` 이면 422. 테스트 발송(`test: true`)에서는 무시합니다 |
| 제한 | `sample_percent` 5~50, `wait_minutes` 5~1440 |

표본 발송은 판정이 끝날 때까지 `processing` 으로 남습니다(같은 워커가 판정 시각에 다시 집어 갑니다 — 별도 스케줄러가 없습니다). 승자 본발송은 원본의 딥링크·이미지·data·알림 옵션·현지 시각 설정을 그대로 물려받고, 방해금지 시간대와 빈도 상한도 그대로 적용됩니다.

콘솔에서는 발송 화면의 변형 아래에서 표본 비율과 판정 대기를 정하고, 로그 상세에서 변형별 표본 결과·승자(또는 승자가 없는 이유)·승자 본발송 링크를 봅니다.

## 발송 속도 제한

프로젝트 설정의 **분당 최대 발송 수**(`max_sends_per_minute`)를 켜면 1분에 그 수만큼만 내보내고, 남은 대상은 다음 분에 이어 보냅니다. 앱 서버나 FCM 쿼터가 한꺼번에 밀려 터지는 것을 막습니다.

```bash
curl -X PATCH "$NOTIKIT/api/admin/projects/$PROJECT_ID" \
  -H "content-type: application/json" -d '{ "max_sends_per_minute": 500 }'
```

`null` 이면 제한이 없습니다. 상한에 걸린 발송은 중간에 멈춘 것이 아니라 **이어서** 나가므로, 이미 받은 사람에게 다시 가지 않습니다.

발송 대상에서 자동으로 빠지는 것: 수신 거부한 유저·토큰, 비활성(앱 삭제 감지) 디바이스.

## 응답과 재시도(멱등 키)

발송은 큐에 넣고 바로 `202` 로 돌아옵니다. 본문은 `{ "message": { "id", "status", "scheduled_at" } }` 입니다.

네트워크 오류로 다시 보내도 한 번만 나가게 하려면 `Idempotency-Key` 헤더에 요청마다 고유한 값(예: 주문 ID)을 넣으세요.
같은 키로 다시 보내면 새로 발송하지 않고 처음 발송을 `200` 과 `meta.idempotent_replay: true` 로 돌려줍니다.

```bash
curl -X POST "$NOTIKIT/api/v1/messages" \
  -H "api-key: nk_xxx" -H "api-secret: sk_xxx" \
  -H "Idempotency-Key: order-1042-shipped" \
  -H "content-type: application/json" \
  -d '{ "type": "single", "target": "user_42", "title": "배송이 시작됐어요" }'
```

치환까지 마친 푸시가 FCM 한도(4KB)를 넘으면 `422` 입니다. 본문이나 `data` 를 줄이세요.

## 로케일별 문구

한 발송이 언어별 제목·본문을 함께 들고 간다. 발송을 언어 수만큼 쪼개면 한 캠페인의 성과가
여러 로그로 흩어진다.

```json
{
  "type": "topic", "target": "vip",
  "title": "Sale starts now", "body": "Up to 50% off",
  "locales": {
    "default": { "title": "Sale starts now", "body": "Up to 50% off" },
    "ko": { "title": "세일 시작", "body": "최대 50% 할인" },
    "ja-JP": { "title": "セール開始", "body": "最大50%オフ" }
  }
}
```

고르는 순서는 **정확히 맞는 태그 → 언어만 맞는 태그 → `default` → 발송 본문**이다.
로케일은 사람(`identify` 의 locale) > 기기 등록값 순으로 본다. `ko_KR`(Android·Flutter)과
`ko-KR`(웹)은 같은 값으로 접히므로 플랫폼에 따라 절반이 갈리지 않는다.

**폴백은 반드시 보인다.** 맞는 언어가 없어 기본 문구를 받은 인원과 그 로케일이
`push_logs.locale_fallbacks` 에 쌓이고 상세 API 가 그대로 돌려준다.

```json
"locale_fallbacks": { "total": 1240, "byLocale": { "fr": 820, "de": 400, "": 20 } }
```

`""` 는 로케일을 모르는 기기다. 이 칸이 크다면 번역을 넣었다고 믿고 있을 뿐 실제로는
아무도 못 받고 있다는 뜻이다. 변형(A/B)과 함께 쓸 수 없고(422), 기본 문구가 어디에도
없으면(=`title`/`body`·`template`·`default` 가 전부 없으면) 거절한다.

## 홀드아웃 — 리프트 증명

A/B 는 변형끼리만 비교하므로 "푸시가 없었을 때보다 나은가"를 끝내 말하지 못한다.
`holdout_percent` 는 그 비율의 사람에게 **아무것도 보내지 않고** 전환만 비교한다.

```json
{ "type": "broadcast", "title": "…", "body": "…", "holdout_percent": 10 }
```

배정은 **사람 단위로 고정**이다(사람이 없는 익명 기기는 토큰). 발송마다 다시 뽑으면 매 캠페인의
대조군이 달라져, 재는 것이 "푸시의 효과"가 아니라 "그날 누가 뽑혔는가"가 된다. A/B 표본
버킷과는 다른 해시 키를 써서 두 축이 붙지 않는다. 승자 본발송에도 같은 대조군이 이어진다 —
아니면 표본에서 빼 둔 사람이 본발송을 받아 대조군이 사라진다.

대조군은 푸시를 안 받았으니 클릭이 없다. 그래서 전환 보고는 클릭이 없을 때 최근 24시간 안의
홀드아웃 명단을 보고 그 발송에 `holdout: true` 로 귀속한다. 상세 API 가 둘을 갈라 준다.

```json
"holdout": { "percent": 10, "devices": 5120, "conversions": { "count": 61, "valueCents": 812000 }, "lift": 0.42 }
```

`lift` 는 대조군 전환율이 0 이면 `null` 이다(0% 나 무한대로 적지 않는다).
`type=single` 에는 쓸 수 없다 — 한 명뿐이라 "전부 빼거나 아무도 안 빼거나"가 된다.

## 도달 확인(수신 보고)

`success_count` 는 **FCM 이 접수한 수**다. 기기가 꺼져 있어도, 앱이 지워졌어도 접수는 성공한다 —
그 수를 도달로 읽으면 도달률이 늘 실제보다 높고 그 위에 올린 비교도 같이 뜬다.

알림이 단말에 도착하면 SDK 가 보고한다.

```
POST /api/v1/messages/received
api-key: <공개 키>

{ "log_id": "<푸시 data 의 notikit_log_id>", "token": "<단말 토큰>" }
→ 202 { "recorded": true }
```

(발송, 기기) 유니크라 재시도·중복 콜백으로 여러 번 보내도 한 번만 센다(`recorded: false`).
클릭과 같은 자격 검사를 걸어 아무 토큰이나 등록해 도달 수를 부풀리지 못한다.
결과는 `push_logs.delivered_count` 로 쌓이고, 화면에서도 접수 수와 **다른 칸**이다.

## 캠페인별 재정의

방해금지 시간대와 발송 속도 제한은 프로젝트 설정이라, 거래성 발송(주문·인증)이 마케팅용
야간 금지와 스로틀을 그대로 물려받는다. 발송 단위로 덮을 수 있다.

| 필드 | 뜻 |
|---|---|
| `"quiet_hours": false` | 프로젝트 방해금지 시간대를 무시하고 즉시 보낸다 |
| `"max_sends_per_minute": 2000` | 이 발송에만 적용할 분당 상한 |
| `"max_sends_per_minute": 0` | 이 발송은 속도 제한 없음 |

`0` 과 "주지 않음"은 다르다 — 주지 않으면 프로젝트 설정을 따르고, `0` 은 명시적 해제다.
승자 본발송에도 그대로 이어진다.

## 발송 취소

대기·예약·진행 중인 발송을 멈춘다.

```
POST /api/admin/projects/{id}/logs/{logId}/cancel
→ 200 { "log": { "status": "canceled", "canceled_at": "…", "canceled_by": "ops@example.com",
                 "sent": { "total": 42310, "success": 41980, "failure": 330, "holdout": 0 } } }
```

`canceled` 는 클레임 조건(queued/scheduled/processing)에 없으므로 어떤 워커도 다시 집지 않는다.
진행 중이던 워커는 `lock_token` 을 함께 빼앗겨 **다음 페이지를 넘기지 않는다** — 토큰을 그대로
두면 워커는 취소를 모른 채 끝까지 다 보내고 화면만 "취소됨"이 된다.

**이미 나간 수를 반드시 함께 준다.** 대형 발송은 버튼을 누르는 순간 이미 수만 건이 나간 뒤일 수
있는데, "취소됨"만 보여 주면 운영자는 아무에게도 안 갔다고 읽는다. 취소 시점의 진행 상태를
로그 칼럼으로 굳히고, 그 직후 한 페이지가 더 나갔다면 워커가 빠지면서 그 수까지 더한다.

끝난 발송(completed/logged/failed)과 이미 취소된 것은 409 — 되돌릴 것이 없다.
