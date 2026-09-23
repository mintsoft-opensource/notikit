---
title: 2차 — 기능·아키텍처 점수 올리기
status: done
created: 2026-09-23
base: docs/plan/review-scores-and-fixes.md (1차 결과: 디자인 85 · 아키텍처 76 · 기능 62 · 보안 85 · 접근성 83 · 코드품질 82 · DX 81)
---

# 2차 — 기능·아키텍처 점수 올리기

재리뷰가 공통으로 지적한 것만 한다. 가장 낮은 기능(62)·아키텍처(76)가 목표.

## A. 알림 옵션 · 전환 측정 (백엔드)
소유: `src/db/schema.ts`, `drizzle/**`, `src/lib/messages.ts`, `src/lib/fcm.ts`, `src/lib/push-processor.ts`, `src/lib/openapi.ts`, `apps/web/docs/04-sending.md`, `packages/sdk-*`, `src/app/api/v1/events/**`, `src/app/api/v1/messages/click/route.ts`.

1. **알림 옵션** — `push_logs.options jsonb`(한 컬럼). `messageSchema` 에 `options` 추가:
   `sound`(문자열 또는 `"default"`), `badge`(0 이상 정수), `collapse_key`(≤64), `android_channel_id`(≤64), `ios_thread_id`(≤64),
   `ttl_seconds`(0–2419200), `priority`(`normal|high`, 기본 high), `silent`(불리언 — data-only, 제목·본문 없이 보냄),
   `actions`(최대 3개 `{ id, title, deep_link? }`).
   FCM 매핑: Android `ttl`·`priority`·`collapse_key`·`notification.channel_id`·`notification.sound`,
   APNs `aps.sound`·`aps.badge`·`aps.thread-id`·`apns-collapse-id`·`apns-expiration`·`content-available`(silent),
   웹은 `data` 로. `actions` 는 `data.actions`(JSON 문자열)로 넣고 SDK 가 읽는다.
   4KB 검사에 옵션 포함. `silent` 면 제목·본문 없어도 통과.
2. **변형별 클릭** — `push_clicks.variant smallint null`. 클릭 기록 때 그 기기에 배정된 변형을 저장(배정 규칙은 `push-processor` 의 해시와 같아야 한다).
3. **전환 측정** — 새 테이블 `push_conversions(id, project_id, log_id, user_id, name text, value_cents integer null, created_at)`.
   `POST /api/v1/events`(앱 SDK 인증): `{ name, value_cents?, token 또는 user_id + identity_hash }`.
   귀속: 그 기기/사용자가 **최근 24시간 안에 클릭한 마지막 발송**에 붙인다. 클릭이 없으면 저장하지 않고 202.
   같은 (log, user, name) 은 하루 1건(유니크).
4. 마이그레이션 `0023_notification_options.sql` 하나에 위 3개(컬럼·컬럼·테이블+인덱스) + 저널 idx 23(끝 줄바꿈 없음).
5. SDK: 발송 옵션(`options`)을 `send()` 에 노출, 앱 SDK 는 `actions` 를 읽어 내려주고 `trackConversion(name, valueCents?)` 추가.

## Q. 신뢰성 (백엔드, A 와 파일 겹치지 않음)
소유: `src/lib/rate-limit.ts`, `src/lib/redis.ts`(새), `src/lib/webhooks.ts`, `src/lib/kakao.ts`, `worker.mjs`, `src/app/api/admin/projects/[id]/process-queue/route.ts`, `src/app/api/internal/**`.
1. **공유 rate limit** — `REDIS_URL` 이 있으면 Redis 고정창 카운터, 없으면 지금의 메모리 방식(로그 경고 1회). 동작은 같아야 한다.
2. **웹훅·알림톡 재시도** — 실패 배달을 지수 백오프로 재시도하는 스윕(`webhook_deliveries.attempts` 사용, 최대 5회, 1·5·25분…). 워커가 주기적으로 호출.
3. **워커** — 스윕 호출 추가, 실패 로그, 종료 시 진행 중 작업 대기.

## U. 화면 마감 (재리뷰 MEDIUM·LOW)
소유: `src/components/console/update-panel.tsx`, `send-user-picker.tsx`, `src/components/ui/date-picker.tsx`, `src/app/(app)/tester/page.tsx`, `projects/page.tsx`, `profile/page.tsx`, `src/app/globals.css`.
1. 아이콘 `aria-hidden`, `animate-spin` 에 `motion-safe` 가드, 전역 `prefers-reduced-motion` 규칙.
2. 컨트롤 크기 통일: `tester` 의 `size="lg"` → 기본 36px, 칸 안 보조 버튼은 28px 규칙 유지(예외는 주석으로).
3. 프로젝트·프로필 화면 빈 공간 정리(요약 타일·최근 활동 등 이미 있는 데이터로).

## 2차에서도 안 하는 것
저니 분기·이벤트 트리거, 행동 기반 세그먼트, 받는 사람 현지 시각 발송, 승인 워크플로, AI 기능.

## 합격 기준
tsc 0 · vitest · SDK 테스트 · Playwright 전부 통과, 24개 로케일 누락 0, 재리뷰에서 기능·아키텍처 점수 상승 및 HIGH 0.

## 결과 (2026-09-23)

A·Q·U 를 병렬로, 그 뒤 화면 2차(옵션 UI·변형 클릭률·전환 지표)를 붙였다.

- **알림 옵션**: `push_logs.options jsonb` 하나. `sound`·`badge`·`collapse_key`·`android_channel_id`·`ios_thread_id`·`ttl_seconds`·`priority`·`silent`·`actions`(최대 3).
  Android `ttl`·`priority`·`collapseKey`·채널·사운드, APNs `apns-collapse-id`·`apns-expiration`·`aps.sound/badge/threadId`·`contentAvailable`, 웹·무음은 data-only.
  옵션 포함해 4KB 검사, `silent` 면 제목·본문 없이 통과. 콘솔은 3단계 카드 안 접이식 "알림 옵션"(고정 바 없음).
- **변형별 클릭**: `push_clicks.variant`. 배정 해시는 `src/lib/push-variant.ts` 하나로 발송기·클릭 라우트가 공유. 로그 상세 비교표에 클릭·클릭률 열과 1등 표시.
- **전환**: `push_conversions` + `POST /api/v1/events`(최근 24시간 마지막 클릭에 귀속, 같은 (발송·사용자·이름)은 하루 1건). 로그 상세 카드와 개요·참여 KPI 타일(전기간 대비).
- **신뢰성**: `REDIS_URL` 이 있으면 Redis 고정창 rate limit(없으면 메모리 폴백), 웹훅 재시도 백오프 1·5·25·125분(최대 5회, `webhook_deliveries.next_attempt_at`), 워커 60초 스윕과 종료 시 대기, 알림톡 일시 실패 1회 재시도.
- **화면 마감**: `prefers-reduced-motion` 전역 대응, 장식 아이콘 `aria-hidden`, 컨트롤 36px 통일, 프로젝트 요약 타일·프로필 조직 카드.

마이그레이션 `0023_notification_options`, `0024_webhook_retry`. 새 env: `REDIS_URL`, `WORKER_WEBHOOK_SWEEP_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS`.

검증: tsc 0 · vitest 197 · SDK 75(core 39·web 16·react 9·RN 11) · next build · Playwright **111 통과**. 24개 로케일 누락 0(새 키 70개).
