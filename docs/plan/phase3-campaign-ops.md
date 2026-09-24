---
title: 3차 — 캠페인 운영 격차 메우기
status: done
created: 2026-09-24
base: docs/plan/phase2-score-lift.md (3차 리뷰 결과: 디자인 88 · 아키텍처 81 · 기능 71 · 보안 84 · 접근성 88 · 코드품질 84 · DX 83)
---

# 3차 — 캠페인 운영 격차 메우기

기능(가장 낮음)이 목표. 제품 리뷰가 준 최소 구현 범위 그대로 한다. 순서는 리뷰 권고를 따른다.

## P1 행동 기반 세그먼트
소유: `src/lib/topic-membership.ts`, `topic-rule-ops.ts`, `audience-count.ts`, `click-eligibility.ts` (+테스트).

`TopicRule` 을 유니온으로 넓힌다. 기존 속성 규칙은 그대로 두고(저장된 데이터 호환), 행동 규칙을 더한다:

```ts
| { attribute: string; op?: AttrOp; value: string }                    // 지금 것
| { source: "click" | "conversion" | "activity" | "send";
    op: "within_days" | "not_within_days" | "count_gte";
    days?: number; count?: number; name?: string }                     // 새 것
```

- 데이터는 이미 있다: `push_clicks`, `push_conversions`, `device_activity`, `push_user_sends`.
- `ruleCond` 한 곳에 `EXISTS` 서브쿼리로 넣는다 → `resolveScope`·`countTopicAudience`·`click-eligibility` 가 따라온다.
- **함정**: `kind:"rules"` 가 `pushUsers` 를 innerJoin 해서 익명 기기를 버린다. 행동은 기기에 남으므로 사용자 없는 기기도 세어야 한다(휴면 재활성 세그먼트가 조용히 반토막 난다).

## P2 받는 사람 현지 시각 발송
소유: `src/lib/quiet-hours.ts`, `messages.ts`, `push-processor.ts`, `src/db/schema.ts`, `drizzle/**`.

`push_users.timezone` 이 이미 있는데 발송에 안 쓴다. 발송 옵션에 "각자 현지 09:00"(`local_time: "HH:MM"`)을 더한다.
처리기가 기기의 시간대별로 묶어, 아직 그 시각이 안 된 묶음은 다음 회차로 미룬다(하루 창 안에서만, 지나면 즉시).

## P3 반복 예약
소유: `src/db/schema.ts`(P2 와 같은 마이그레이션), `src/lib/schedules.ts`(새), `worker.mjs`, `src/app/api/admin/projects/[id]/schedules/**`.

- cron 문자열 금지. `push_schedules`: daily / weekly(요일) / monthly(일) + 시:분 + `projects.timezone`, `nextRunAt`, `enabled`, 메시지 본문.
- 워커가 도래분마다 `enqueuePush` 를 호출해 `push_logs` 1행을 만든다(방해금지·빈도상한을 그대로 얻는다).
- **함정**: 다운타임 뒤 밀린 회차를 몰아 보내지 말 것. 놓친 회차는 건너뛰고 `idempotencyKey = scheduleId:occurrenceISO` 로 중복을 막는다.

## P4 발송 속도 제한(스로틀)
소유: `src/lib/push-processor.ts`, `project-settings` PATCH(`src/app/api/admin/projects/[id]/route.ts`).

프로젝트당 "분당 최대 N건". `runPages` 루프에서 페이지 사이에 예산을 확인하고, 소진되면 `ResumeState.nextPageAt` 을 적고 **로그를 반납**한다.
**함정**: 루프 안 `sleep()` 금지 — `STALE_MS`(5분)를 넘기면 다른 워커가 재클레임해 중복 발송이 된다.

## P5 A/B 자동 승자
소유: `src/lib/push-processor.ts`, `messages.ts`, `log-detail.tsx`.

- `push_logs.ab_test` jsonb: 표본 %, 판정 대기 시간, 지표는 유니크 클릭률 고정. 승자 본발송은 로그 1행 추가.
- **함정**: `variantIndex` 가 토큰 해시라 표본과 나머지를 **해시 버킷으로** 갈라야 승자 발송이 표본과 겹치지 않는다. 최소 표본·동률 가드 없이 승자를 선언하면 장난감으로 보인다.

## 화면
소유: `src/components/console/topic-rules-form.tsx`, `send-schedule*`, `send-options.tsx`, `project-settings.tsx`, `log-detail.tsx`, 새 `schedules-console.tsx`.

## 이번에도 안 하는 것
트리거 기반 저니 분기(다음 차수 1순위), 승인 워크플로, AI 기능.

## 합격 기준
tsc 0 · vitest · SDK 테스트 · Playwright 전부 통과, 24개 로케일 누락 0, 재리뷰에서 기능 점수 상승 및 HIGH 0.

## 결과 (2026-09-24)

4차 리뷰(디자인 89 · 아키텍처 86 · 기능 82 · 보안 85 · 접근성 91 · 코드품질 88 · DX 85)에서 나온 HIGH 를 함께 처리했다.

- **행동 세그먼트**: `TopicRule` 유니온(`click`·`conversion`·`activity`·`send` × `within_days`·`not_within_days`·`count_gte`). `ruleCond` 한 곳 EXISTS 로 넣어 `resolveScope`·`countTopicAudience`·`click-eligibility` 가 따라온다. 함정대로 `innerJoin push_users` → `leftJoin` 으로 바꿔 익명 기기를 살렸다.
- **현지 시각 발송**: 본문 `local_time: "HH:MM"`. 기기 시간대(사람>기기>프로젝트>UTC) 오프셋으로 묶어 도래한 묶음만 보내고 나머지는 그 시각에. 24시간 창을 넘기면 즉시. 방해금지·빈도 상한을 건너뛰지 않는다.
- **반복 예약**: `push_schedules`(daily/weekly/monthly + 시:분, 프로젝트 시간대). 워커가 도래분마다 `enqueuePush`. 밀린 회차는 **건너뛰고**(15분 유예), `idempotencyKey = id:occurrenceISO` 로 중복을 막는다.
- **발송 속도 제한**: `projects.max_sends_per_minute`. 페이지 사이 예산 확인 후 소진되면 `nextPageAt` 기록 + 로그 반납(루프 안 sleep 금지 — STALE_MS 를 넘기면 중복 발송).
- **리뷰 HIGH**: `settleFailure` 가 DB 를 다시 읽지 않게(그 순단에서 상한이 영영 적용되지 않던 버그), 재클레임을 시도 1회로 계산, 웹훅 배달 행이 없으면 단계를 완료로 적지 않게, FCM 일시 실패 토큰 2회 재시도 + `push_logs.delivery_errors` 에 사유.
- **보안 HIGH**: rate limiter 가 삽입 순서로 축출해 활성 버킷이 먼저 사라지던 우회(재현: 한도 2만에 6만 전부 통과 → 수정 후 2만 허용·4만 차단). 전환 이름 캐시 오염, undici Agent 누수도 같이.
- **배포 HIGH**: prod 마이그레이션 컨테이너가 의존성 부족으로 기동 실패, `.notikit-image.env` 를 아무도 읽지 않아 업데이트가 "성공" 후 구버전 유지, 업데이터가 web 이미지로 내려앉던 문제. **부수 발견**: `docker:27-cli` 의 ENTRYPOINT 가 CMD 를 삼켜 업데이터가 한 번도 돈 적이 없었다.
- **디자인·접근성**: 스켈레톤과 실제 격자 불일치(로딩 때 화면 튐), 상태 칩 이원화, 카드면 3종, 헤더·사이드바 포커스 링, Segmented 36px, 발송 폼 본문 오류의 인라인 표시와 포커스 이동.

구조: `push-processor.ts` 에서 `push-resume`·`send-dispatch`·`local-delivery`·`send-throttle` 분리. 마이그레이션 `0026_local_time_throttle_schedules`.

검증: tsc 0 · vitest 340 · sdk-core 39 · next build · Playwright **120 통과**. 24개 로케일 누락 0(새 키 96개, 전체 1,090).

남은 것(다음 차수): 트리거 기반 저니 분기, A/B 자동 승자, 관측(구조화 로그·지표), `push-processor` 추가 분리.
