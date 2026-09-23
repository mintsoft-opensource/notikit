---
title: 발송 경험 탑티어화 — 1차
status: done
created: 2026-09-22
benchmark: OneSignal, Braze, Airship, Customer.io, FCM console, Iterable, CleverTap (공식 문서 기준)
---

# 발송 경험 탑티어화 — 1차

경쟁 콘솔 5곳 모두에 있고 notikit 에 없는 것 중, 오발송을 막고 작성 품질을 높이는 것부터 한다.

## 1차 범위

| # | 기능 | 근거(보유 제품) |
|---|---|---|
| F1 | 발송 전 도달 인원 추정(사용자·기기·플랫폼) | OneSignal, Braze, Airship, CleverTap |
| F2 | 테스트 발송(사용자 1명에게, 로그에 "테스트" 표시) | 7곳 전부 |
| F3 | 검토 단계(대상·인원·시각·내용·경고 → "N명에게 발송") | Braze, Airship, FCM |
| F4 | iOS / Android 미리보기 탭(실제 잘림 재현) + 글자 수 카운터·잘림 경고 | Airship, Customer.io, Braze, OneSignal |
| F5 | 이미지(리치 미디어) URL | 7곳 전부 |
| F6 | 작성 화면: 번호 단계 카드 + 오른쪽 고정 요약·미리보기 + 하단 고정 액션 바 | Airship, CleverTap |
| F7 | 로그: 상태 칩(색·점·번역), 성공·클릭 미니 막대, 테스트 표시 | OneSignal, Braze |

## 2차 (이번에 안 함)

A/B 테스트 UI(API 는 있음) · 액션 버튼 · 받는 사람 현지 시각 발송 · TTL/우선순위/collapse key/스로틀 · 임시저장 · 발송별 퍼널 상세·실패 원인 표 · `{{` 자동완성 · 테스트 발송 통계 제외.

## API 규격 (서버·화면 공통, 이대로 구현)

### F1 도달 인원 추정

`POST /api/admin/projects/{id}/audience/estimate` (콘솔 세션·`x-admin-token`, read 권한, `checkOrigin`)

```jsonc
// 요청 — 발송과 같은 대상 필드
{ "type": "single" | "multi" | "topic" | "broadcast", "target"?: string, "targets"?: string[] }
// 응답 200
{ "users": 12, "devices": 17, "platforms": { "ios": 9, "android": 7, "web": 1 } }
```

- 활성 기기만, 수신거부(suppression) 제외 — 실제 발송(`push-processor` 의 `countAudience`)과 **같은 함수**로 센다. `countAudience` 를 `lib/audience-count.ts` 로 옮겨 둘이 공유.
- 없는 토픽·사용자는 0. 대상 필드 검사는 `targetError` 재사용(422).

### F2 테스트 발송 · F5 이미지

`messageSchema`(콘솔·SDK 공통)에 추가:

```jsonc
{ "image_url"?: "https://…"  /* https 만, 최대 2048 */, "test"?: boolean /* 콘솔(admin) 라우트에서만 반영, v1 은 무시 */ }
```

- `push_logs` 에 `image_url text`, `is_test boolean not null default false` (마이그레이션 `0020_push_log_image_test.sql`).
- 발송 처리기: `image_url` 을 FCM `notification.imageUrl`(Android·iOS) 로. 웹(data-only)은 `data.image`. iOS 이미지 표시를 위해 APNs `mutable-content: 1` 과 `fcm_options.image`.
- 로그 목록·상세 API 응답에 `imageUrl`, `isTest` 포함.
- 테스트 발송은 화면에서 `type: "single"`, `target: <고른 사용자>`, `test: true` 로 보내고 곧바로 `process-queue`.

## 화면 규격 (F3·F4·F6·F7)

- 작성: 왼쪽 카드 3개(① 받는 사람 ② 내용 ③ 옵션), 카드 머리에 번호 배지, 채워지면 체크. 오른쪽 `sticky` 열: 요약 카드(F1 결과·발송 시각·경고 목록) 위, 미리보기 아래. 폭 제한 없음.
- 미리보기: `iOS | Android` 탭. iOS 제목 1줄·본문 4줄, Android 접힘 제목 1줄·본문 1줄 / 펼침 본문 7줄. 이미지 있으면 표시.
- 카운터: 제목 권장 50자, 본문 권장 150자(OneSignal 가이드). 넘으면 amber + "iOS 에서 잘릴 수 있음".
- 하단 고정 액션 바: 왼쪽 "대상 N명 · 기기 M대", 오른쪽 `테스트 발송`(outline) · `검토 후 발송`(primary). 예약이면 "검토 후 예약".
- 검토 다이얼로그: 대상·인원·시각·제목·본문(치환된 미리보기)·경고 → "N명에게 발송"/"예약". 전체 발송의 `confirm()` 과 "즉시 처리" 체크박스는 여기로 흡수(즉시 처리는 기본 켬, 다이얼로그 안 체크박스).
- 로그 상태 칩: queued·scheduled·processing·completed·logged·failed 를 번역 + 색 점. `isTest` 면 "테스트" 칩. 성공/대상 옆에 성공률·클릭률 미니 막대.
- 디자인 규칙: [[notikit-uniform-control-sizing]] (컨트롤 36px·rounded-lg·아이콘 16px·간격 16px), 전체 폭.

## 합격 기준

1. 대상 선택·변경 후 1초 안에 요약 카드의 인원·기기·플랫폼 수가 갱신되고, 실제 발송 후 로그의 대상 수와 같다(e2e).
2. 테스트 발송이 고른 사용자에게만 가고 로그에 "테스트" 칩이 보인다(e2e).
3. 발송은 검토 다이얼로그를 거쳐야만 나간다. 전체 발송도 같다(e2e).
4. `image_url` 이 http 면 422, https 면 로그·FCM 페이로드에 실린다(e2e·단위).
5. 제목 51자 이상이면 경고가 보인다. iOS/Android 탭 전환 시 잘림이 달라진다.
6. tsc 0 · vitest · Playwright 전부 통과, 24개 로케일 누락 키 0.

## 결과 (2026-09-22)

- F1–F7 모두 구현. 서버·화면을 bkit `pdca-iterator` 2개가 이 문서의 규격으로 병렬 구현.
- 검증: tsc 0 · vitest 74 · sdk-core 18 · Playwright e2e **87 통과**(신규: 추정=실제 발송 수 4타입, 테스트 발송 admin/v1, 이미지 http 422·https 저장, 요약 추정, 전체 발송 검토 게이트, iOS/Android 잘림, 제목 51자 경고, 테스트 칩). 24개 로케일 누락 키 0.
- 규격과 다른 점: 추정 응답 `platforms` 에 `other`(Flutter·RN 등 플랫폼 미상) 추가 — `ios+android+web+other = devices`. 웹 서비스워커가 `data.image` 를 알림 이미지로 쓰도록 한 줄 추가.
- 배포 주의: 마이그레이션 `0019`(사용자 이름)·`0020`(이미지·테스트 표시). iOS 이미지는 앱에 Notification Service Extension 이 있어야 보인다.
