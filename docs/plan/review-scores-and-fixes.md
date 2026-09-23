---
title: 분야별 리뷰 점수 · 일괄 수정
status: done
created: 2026-09-22
reviewers: bkit:frontend-architect, ecc:architect, bkit:product-manager, ecc:security-reviewer, ecc:a11y-architect, ecc:typescript-reviewer, Codex
---

# 분야별 리뷰 점수 · 일괄 수정

## 점수 (수정 전)

| 분야 | Claude 에이전트 | Codex | 평균 |
|---|---|---|---|
| UI·시각 디자인 | 75 | 80 | 78 |
| 아키텍처·설계 | 60 | 62 | 61 |
| 기능 완성도 | 61 | 43 | 52 |
| 보안 | 74 | 77 | 76 |
| 접근성·다국어 | 75 | — | 75 |
| 코드 품질·테스트 | 85 | 67 | 76 |
| 개발자 경험 | — | 70 | 70 |

## 이번에 고치는 것 — 4개 작업 묶음(파일 소유 분리)

### W1 발송 코어 · 성능 · 신뢰성 (아키텍처 H 6건 + Codex H)
소유: `src/lib/push-processor.ts`, `audience-count.ts`, `fcm.ts`, `journeys.ts`, `messages.ts`, `quiet-hours.ts`, `worker.mjs`, `src/app/api/v1/messages/**`, `src/app/api/admin/projects/[id]/messages/route.ts`, `.../process-queue/route.ts`, `.../logs/**`(API), `src/db/schema.ts`, `drizzle/**`, 새 `push-processor.test.ts`.
1. 도달 인원·분모를 **SQL 집계**로(COUNT, COUNT DISTINCT, FILTER platform). 억제는 `NOT EXISTS` 조인(바인드 파라미터 한도 제거).
2. 인덱스: `devices (project_id, id) WHERE is_active` 부분 인덱스. 토픽 경로 커서는 `subscriptions.device_id` 순서.
3. 개인화 발송: 토큰별 메시지 배열을 `sendEach`(≤500)로. `Intl.DateTimeFormat` 캐시(`personalize.ts` 는 W1 이 수정).
4. 클릭 카운터: 트랜잭션 안에서 insert 성공 시에만 +1 (전체 재집계 제거) — `src/app/api/v1/messages/click/route.ts`.
5. **재클레임 시 이어서 발송**: `push_logs.resume_cursor` 에 페이지마다 커서·누적 카운터 저장, 재클레임 시 커서부터. 무효/검증 토큰 처리는 페이지마다.
6. 저니 발송: advance + `enqueuePush` 를 한 트랜잭션으로(방해금지·검증 적용).
7. **멱등 키**: `Idempotency-Key` 헤더(v1·admin 발송). `(project_id, idempotency_key)` 유니크, 같은 키면 처음 결과 반환. v1 발송 응답은 DTO `{ id, status, scheduled_at }` 로(행 전체 노출 금지).
8. FCM 페이로드 4KB 검증: 최종 직렬화 크기 초과 시 422(치환 전 템플릿 기준 + 여유).
9. 워커: 요청마다 deadline(AbortSignal), 프로젝트 동시성 N(기본 4), 실패 로깅.
10. 빈도 상한: `projects.frequency_cap_per_day`(null=없음). 처리기에서 최근 24h 에 이미 받은 사용자 제외(테스트 발송 제외).
11. 발송자 기록: `push_logs.sent_by`(콘솔 발송이면 멤버 이메일, API 면 `"api"`), 로그 상세 API 응답에 `sentBy`.
12. `processPushLog` 를 단계 함수로 분리(<50줄), `project` null 가드, 카카오 폴백 실패 로깅. 순수 함수·상태기계 단위 테스트.
마이그레이션 `0021_delivery_reliability.sql` 하나에: 부분 인덱스, `push_logs.resume_cursor text`, `idempotency_key text` + 부분 유니크, `sent_by text`, `projects.frequency_cap_per_day integer`.

### W2 보안 · 빌드 · SDK 계약
소유: `apps/web/package.json`(+lock), `next.config.ts`, `Dockerfile`, `.github/workflows/**`, `src/lib/templates.ts`, `src/lib/authz.ts`, `packages/**`.
1. `next` ≥ 16.3.3 (CRITICAL RCE 2건), `images.unoptimized: true`.
2. Dockerfile: 워크스페이스 패키지(`@notikit/core`, `@notikit/license`)를 설치 단계에 복사, frozen lockfile.
3. CI: 릴리스 전에 tsc·vitest·SDK 테스트 게이트(Playwright 는 Postgres 서비스로).
4. 예약 키 검사 정규화(소문자·NFKC).
5. `checkOrigin`: 프로덕션에서 `APP_ORIGIN` 없으면 기동 로그 경고 + 요청 헤더 기반 추정 유지(깨지지 않게), 문서화.
6. sdk-core `send()` 에 `scheduledAt`, `variants`, `kakaoFallback`, `idempotencyKey`(헤더) 추가 + 테스트.

### W3 접근성 · 디자인 토큰 · 공통 UI
소유: `src/app/globals.css`, `src/components/ui/**`, `src/components/layout/**`, `src/app/(app)/layout.tsx`, `console/log-status.tsx`, `users-console.tsx`, `devices-console.tsx`, `members-panel.tsx`, `template-form.tsx`, `webhooks-console.tsx`(레이아웃만), `send-content-fields.tsx`, `send-user-picker.tsx`(클래스만).
1. 다크 모드 `--error/--success/--warning` 토큰(4.5:1 이상), `--muted-foreground` on `--surface-muted` 4.5:1.
2. 포커스 링 `ring-ring/40` → 3:1 이상.
3. 물리 `left/right/pl/pr` → 논리 `start/end/ps/pe`(RTL).
4. 본문 바로가기 링크, 모바일 드로어 `inert` 잠금, 모바일 헤더 경로 표시, 헤더·사이드바 아이콘 규칙.
5. `motion-safe:` 로 비필수 애니메이션 가드, 체크박스 24px 히트 영역, 비밀번호 힌트.
6. 아이콘 컨테이너 크기 규칙(28px 보조 / 36px 조작), `RateBar` 데이터 없을 때 막대 숨김, 숫자 열 `text-right tabular-nums`, 모바일 로그 막대 줄바꿈, 차트 빈 상태에 흐린 축 배경, 웹훅 등록 버튼 정렬, 조직 사이드바 "설정" 중복 이름.
7. `StatTile` 에 `delta` prop(▲▼ + 색) — 데이터 연결은 W4.

### W4 기능 보강 · 화면
소유: `send-console.tsx` 와 `send-*`(W3 소유 제외), `topic-membership.ts`, `click-eligibility.ts`, `topic-rules-form.tsx`, `topic-detail.tsx`, `project-settings.tsx`, `src/app/api/admin/projects/[id]/route.ts`(PATCH), `.../stats/**`(전기간 대비), 웹훅 배달 이력 API·화면, 억제 CSV 가져오기 API·화면, `log-detail.tsx`, `project-overview.tsx`, `engagement-console.tsx`, 조직 화면(`app/(app)/projects|settings|profile|account`).
1. **A/B 변형 UI**(API 는 있음): 작성 화면에 변형 B 추가(제목·본문), 로그 상세에 변형별 발송·성공.
2. **토픽 규칙 연산자**: `{ attribute, op, value }`, op = eq·neq·gt·gte·lt·lte·contains(기본 eq, 기존 데이터 호환). `attrConds` 한 곳에서 처리, `click-eligibility` 도 이것을 사용.
3. **빈도 상한 설정 UI**(설정 화면 + PATCH `frequency_cap_per_day`).
4. **발송자 표시**(로그 상세 `sentBy`).
5. **웹훅 배달 이력**(목록·상태·응답 코드) — `webhook_deliveries` 사용.
6. **억제 목록 CSV 가져오기**(user_id 또는 token 열, 최대 5,000행).
7. KPI 전기간 대비(StatTile `delta`) — 개요·참여 화면.
8. 발송 결과를 **해당 메시지 ID 의 실제 상태**로 표시(큐 전체 처리 결과가 아니라).
9. 조직 화면 빈 공간 정리(프로젝트·설정·프로필), 설정 화면 레이아웃.
10. 코드 품질: 렌더 중 ref 대입 제거, `send()` 대상 가드.

## 2차로 미루는 것
저니 분기·이벤트 트리거, 행동 기반 세그먼트, 받는 사람 현지 시각 발송, TTL·우선순위, 승인 워크플로, AI(카피 제안·발송 시간·이상 탐지), 공유 rate limit(Redis), FCM 일시 오류 재시도·백오프.

## 합격 기준
1. 네 묶음의 항목이 모두 구현되고 tsc 0 · vitest · SDK 테스트 · Playwright 전부 통과, 24개 로케일 누락 키 0.
2. 재리뷰에서 모든 분야 점수가 수정 전보다 오르고, HIGH 0건.

## 결과 (2026-09-23)

W1–W4 를 bkit `pdca-iterator` 4개가 병렬로 구현한 뒤, 같은 리뷰어로 다시 채점했다. 재채점에서 나온 HIGH 는 모두 고쳤다.

| 분야 | Claude 에이전트 | Codex | 평균 (전 → 후) |
|---|---|---|---|
| UI·시각 디자인 | 75 → 83 | 80 → 86 | 78 → **85** |
| 아키텍처·설계 | 60 → 78 | 62 → 73 | 61 → **76** |
| 기능 완성도 | 61 → 69 | 43 → 54 | 52 → **62** |
| 보안 | 74 → 88 | 77 → 81 | 76 → **85** |
| 접근성·다국어 | 75 → 83 | — | 75 → **83** |
| 코드 품질·테스트 | 85 → 86 | 67 → 78 | 76 → **82** |
| 개발자 경험 | — | 70 → 81 | 70 → **81** |

재채점 HIGH 와 처리:
- 웹훅 배달 이력 "더 보기" 멈춤 → 목록 재조회 때 초기화.
- RTL 물리 방향 클래스 37곳 → 논리 속성(`text-end`·`ms`·`me`·`border-s`).
- 수신거부 사용자에게 인박스·알림톡 후속 발송 → 억제 제외 적용.
- 빈도 상한 동시 처리 경합 → 프로젝트 advisory lock 안에서 **발송 전 예약**, 실패한 사용자는 예약 해제. 로그 전용 모드는 기록 안 함.
- 완료 표시 뒤 후속 단계 유실 → 완료 전에 실행, 단계별 완료 표시를 `resume_cursor` 에, 인박스 `(log, user)` 유니크로 멱등.
- 페이지 발송 직후 커서 저장, 발송 뒤 부수 기록 실패가 커서 저장을 막지 않게.

함께 고친 MEDIUM: 억제 인덱스(`0022`), 토픽 인원 SQL 집계 + 억제 제외, 컨테이너 `USER node`, 규칙 폼·빈도 상한 오류 문구, 발송 결과 낭독 반복, 발송 후 이미지·딥링크·예약·필드 초기화, 참여 표 여백, 변형별 비교표.

검증: tsc 0 · vitest 145 · sdk-core 32 · next build · Playwright **101 통과**. 24개 로케일 누락 키 0(새 키 76개).

남은 것(2차): 발송 단위 at-least-once(페이지 단위 중복 가능성, 문서화), 알림톡 재시도, FCM 호출 타임아웃·재시도, Redis 공유 rate limit, drizzle-orm 0.45 업그레이드(현재 공격 경로 없음), A/B 변형별 클릭률·승자 선택, 액션 버튼·사운드·collapse key 등 알림 옵션, 전환 지표.
배포 주의: 마이그레이션 `0021`(발송 신뢰성), `0022`(억제 인덱스·인박스 멱등). 컨테이너가 이제 `node` 사용자로 돈다.
