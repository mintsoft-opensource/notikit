---
title: 웹 콘솔 프론트엔드 리뷰 수정
status: done
created: 2026-09-22
sources:
  - Codex frontend review (29 findings)
  - Claude frontend review — bkit:frontend-architect + vercel-react-best-practices + ecc:frontend-a11y (34 findings)
executor: bkit (일괄 수정 후 재리뷰)
---

# 웹 콘솔 프론트엔드 리뷰 수정

## Context

두 리뷰(Codex, Claude)가 `apps/web` 콘솔 전체를 봤다. 중복을 합치면 **확정 지적 52건**이다.
콘솔 운영자가 실제로 겪는 문제가 대부분이다: 필터를 바꾸는 사이 옛 목록이 섞이고, 저장 중 고친 내용이 사라지고,
실패하면 스켈레톤이 영원히 돈다. 보안 1건(발송 `data` 가 예약 키를 덮어씀)은 서버 API 를 쓰는 고객사에 영향이 있다.
직전 커밋에서 컨트롤 크기·간격을 통일했는데(`h-9`·`rounded-lg`·16px 아이콘·`gap-4`), 그 규칙을 벗어난 곳도 남아 있다.

## Current State (2026-09-22, `master` + 미커밋 디자인 통일 변경 위에서 검증)

직접 코드로 확인한 대표 지적:

| 지적 | 근거 |
|---|---|
| 발송 `data` 가 아무 키나 받음 | `apps/web/src/lib/messages.ts:32` `z.record(z.unknown())` |
| "더 보기"에 오래된 응답 가드 없음 | `apps/web/src/components/console/devices-console.tsx:110` `loadMore` |
| 템플릿 적용이 빈 제목·본문을 덮지 않음 | `apps/web/src/components/console/send-console.tsx:116-117` `if (tpl.title)` |
| 웹훅 목록 로딩 중 "없음" 표시 | `apps/web/src/components/console/webhooks-console.tsx:23` `useState<Webhook[]>([])` |
| 토픽 규칙 저장·삭제 재진입 가드 없음 | `apps/web/src/components/console/topic-detail.tsx:50,72` |
| 에러 바운더리 없음 | `apps/web/src/app/(app)/**/error.tsx` 0개 |
| 헤더·사이드바 아이콘 17/18/20px | `layout/header.tsx:117,150,170`, `sidebar.tsx:25`, `theme-toggle.tsx:30` |

### 결정 사항 (사용자 확정)

- **D1** 발송 `data` 에 예약 키가 오면 **422** (템플릿 필드 키 규칙과 동일 목록).
- **D2** 접근성 대형 항목 5개 **모두 포함**.
- **D3** 다른 칸 **안에** 들어간 조작 요소(칩 삭제 X, 날짜 지우기 X, 다중 선택 칸 안 "사용자 추가")는 36px 예외, **28px(`h-7`)로 통일**. 따로 서 있는 버튼은 전부 36px. 변수 칩은 따로 서 있으므로 36px.
- **D4** 참여 화면 발송 순위의 기간 필터는 **포함**(서버 변경). 콘솔 API 응답 zod 런타임 검증은 **하지 않음**.

## Proposed Change — 작업 패키지

심각도: **H**(데이터가 틀리거나 사라짐, 보안) · **M**(잘못된 표시·조작 불가·규칙 위반) · **L**(정리).

### WP1 서버·보안 (H) — 먼저

| # | 파일 | 변경 |
|---|---|---|
| 1.1 | `apps/web/src/lib/messages.ts:32` | `data` 에 `isReservedKey` 키가 있으면 422 `"data key is reserved: <key>"`. `isReservedKey` 는 `lib/templates.ts` 것을 재사용 |
| 1.2 | `apps/web/src/lib/messages.ts` `prepareMessage` | 템플릿 필드와 합친 뒤에도 같은 검사(현재 `applyTemplate` 가 `req.data` 를 그대로 병합) |
| 1.3 | `apps/web/src/app/api/admin/projects/[id]/logs/route.ts` + `engagement-console.tsx:81` | 참여 화면 발송 순위: 선택한 기간(`from`/`to`)을 서버에 넘기고, 서버가 기간 안 발송을 읽음률로 정렬해 상위 N 반환(`?sort=readRate&limit=20`). 클라이언트 정렬 제거 |

### WP2 비동기 경쟁·중복 요청 (H/M)

공통 규칙: **요청 세대(generation) 번호**를 ref 로 들고, 응답을 반영하기 전에 현재 세대와 같은지 본다. "더 보기"는 진행 중 비활성.

| # | 파일 | 변경 | 등급 |
|---|---|---|---|
| 2.1 | `devices-console.tsx:110`, `users-console.tsx:76`, `installs-console.tsx:92` | `loadMore` 가 초기 로드와 같은 세대 ref 확인, 진행 중 버튼 비활성 | H |
| 2.2 | `logs-console.tsx:222` | 서버 `next` 커서 보관 + "더 보기"(2.1 과 같은 방식) | H |
| 2.3 | `log-detail.tsx:87` | 읽은 사람 목록 `next` 커서 페이지네이션 | M |
| 2.4 | `send-console.tsx:116-117` | 템플릿 적용 시 `title`·`body` 무조건 대입 | M |
| 2.5 | `send-console.tsx:185` | 발송 중 제목·본문 입력 비활성. 성공 시 제출한 값과 같을 때만 비움 | M |
| 2.6 | `send-custom-fields.tsx:42` | 링크로 받은 템플릿은 **아직 아무것도 안 쓴 상태일 때만** 자동 적용, 아니면 일반 덮어쓰기 확인 | M |
| 2.7 | `topic-detail.tsx:50,72`, `journey-detail.tsx:70,79` | `if (busy) return` 재진입 가드 + 저장 중 편집 비활성 | H |
| 2.8 | `template-form.tsx:80` | 저장 중 팝업 닫기·전환 막기(저장 버튼 외 비활성, `onClose` 무시) | M |
| 2.9 | `topics-console.tsx:102` (+ members 비밀번호·역할, suppressions 사유) | 완료 후 초기화는 **드래프트 전체**가 제출 값과 같을 때만(리비전 카운터) | M |
| 2.10 | `members-panel.tsx:90` | 역할 변경 멤버별 pending, 완료 전 그 행 Select 비활성 | M |
| 2.11 | `webhooks-console.tsx:96` | 재시도 `retrying` 상태 + 비활성 | M |
| 2.12 | `layout/header.tsx:40` | 로그아웃 pending 비활성 | M |
| 2.13 | `lib/admin-client.ts:69` `useProjects().reload` | 세대 ref 로 늦게 온 응답 무시 | M |
| 2.14 | `app/(app)/system/page.tsx:115` | 호스트 폴링을 `setInterval` → 완료 후 다음 예약(`setTimeout` 체인), 언마운트 시 취소 | M |

### WP3 로딩·오류 상태 (M)

| # | 파일 | 변경 |
|---|---|---|
| 3.1 | `topic-detail.tsx:41`, `journey-detail.tsx`, `log-detail.tsx` | 404 외 실패 시 무한 스켈레톤 대신 `EmptyState` + 재시도 버튼 |
| 3.2 | `activity-console.tsx:54` | 리텐션 실패를 로딩과 구분(`retFailed`) + 재시도 |
| 3.3 | `app/(app)/projects/page.tsx:20`, `settings/page.tsx:36` | 첫 로드 실패를 빈 목록·기본값 대신 오류 + 재시도로 표시 |
| 3.4 | `webhooks-console.tsx:23` | `hooks` 를 `Webhook[] \| null`, 로딩 중 스켈레톤 |
| 3.5 | 새 파일 `app/(app)/error.tsx` | 앱 셸 안에서 오류 표시 + "다시 시도"(`reset()`) |
| 3.6 | `app/(app)/guide/page.tsx:5` | 문서가 0개면 404 대신 안내 |

### WP4 날짜·시간 (M)

| # | 파일 | 변경 |
|---|---|---|
| 4.1 | `logs-console.tsx:220` | 선택 날짜마다 그날 로컬 자정을 따로 계산해 UTC ISO 로 전송(`from` 포함, `to` 는 다음날 자정 미포함). 오늘 오프셋 재사용 금지 |
| 4.2 | `activity-console.tsx:138`, `app/(app)/dashboard/page.tsx` | 날짜 단위 버킷(UTC 자정)은 `timeZone: "UTC"` 로 포맷 |

### WP5 접근성 (M, D2 로 전부 포함)

| # | 파일 | 변경 |
|---|---|---|
| 5.1 | `components/ui/dialog.tsx:99` | 포커스가 패널 밖으로 나가면 패널로 되돌림, 열린 동안 배경 `inert`, 내용이 바뀌면 첫 포커스 대상으로 이동 |
| 5.2 | `components/ui/segmented.tsx:26` | roving `tabIndex`(선택된 것만 0) + ←→↑↓ 로 선택 이동 |
| 5.3 | `components/ui/date-picker.tsx:111` | DayPicker `labels`(이전·다음 달, 날짜, 오늘, 선택됨)를 next-intl 로 지역화, `dir` 전달 |
| 5.4 | `components/ui/data-table.tsx:94` | 셀 `aria-label={label}` 제거. 모바일 라벨은 `sr-only` 가 아닌 보이는 텍스트/`aria-hidden` 처리, 값이 접근성 이름이 되게 |
| 5.5 | `send-user-picker.tsx:189` | 검색 입력 `role="combobox"` + 결과 `role="listbox"`/`option`, `aria-activedescendant`, ↑↓ 이동·Enter 선택 |
| 5.6 | `components/ui/input.tsx` `Field` | hint 에 id 부여, 자식에 `aria-describedby` 주입 |
| 5.7 | `send-console.tsx:241` | 예약 발송을 `fieldset`/`legend` 로 묶고 날짜·시각 각각 라벨 |
| 5.8 | `send-custom-fields.tsx:111` | 행 삭제 버튼 `aria-label` 에 키 포함(`"{key} 필드 삭제"`) |
| 5.9 | `journey-form.tsx:52`, `topic-rules-form.tsx:31`, `template-form.tsx:134`, `send-custom-fields.tsx:107` | 편집·삭제 가능한 행의 `key={index}` → 행 생성 시 `crypto.randomUUID()` 로 만든 안정 id |

### WP6 디자인 규칙 (M) — [[notikit-uniform-control-sizing]]

| # | 파일 | 변경 |
|---|---|---|
| 6.1 | `layout/header.tsx:117,150,170`, `theme-toggle.tsx:30`, `sidebar.tsx:25` | 아이콘 `h-4 w-4` |
| 6.2 | `logs-console.tsx:344` | 행 펼치기 토글 → `Button variant="ghost" size="icon"` |
| 6.3 | `members-panel.tsx:212` | `Select` 의 `h-8` 제거 |
| 6.4 | `send-variables.tsx:42` | 변수 칩 → `Button variant="outline" size="sm"`(36px, 모노 폰트) |
| 6.5 | `webhooks-console.tsx:118`, `app/(app)/projects/page.tsx:94` | 비밀값·키 복사 버튼 → `Button`(포커스 링 포함) |
| 6.6 | `devices-console.tsx:159` | 필터 줄 `items-end gap-3` |
| 6.7 | `journey-detail.tsx:116`, `app/(app)/system/page.tsx` | 섹션 간격 `space-y-3` → `space-y-4` |
| 6.8 | `send-user-picker.tsx` 칩 X·"사용자 추가", `date-picker.tsx:98` 지우기 X, `dialog.tsx` 닫기 X | D3: 칸 안 요소는 `h-7`(28px)·`rounded-md`·아이콘 14px 로 **한 규칙**에 맞춤. 닫기 X 는 칸 밖이므로 `h-9` |

### WP7 번역 (M)

| # | 파일 | 변경 |
|---|---|---|
| 7.1 | `app/(app)/tester/page.tsx:106` | `tester` 네임스페이스 신설, 하드코딩 전부 이동 |
| 7.2 | `webhooks-console.tsx:136,140` | "active"/"inactive"/"all events" |
| 7.3 | `journeys-console.tsx:149`, `journey-form` | 단계 뱃지 "send"/"wait Nh" |
| 7.4 | `project-overview.tsx:141` | "log-only" 뱃지 |
| 7.5 | `dialog.tsx` 닫기, 차트 표의 "time"/"value" | 번역 키로 |
| 7.6 | `send-custom-fields.tsx:109` | placeholder "key"/"value" |
| 7.7 | `lib/admin-client.ts:28,30,59` | 한국어 에러 문자열 → 코드(`session_expired` 등) 던지고 호출부에서 번역 |

새 키는 `messages/ko.json`·`en.json` 에 넣고 23개 언어는 `scripts/console-translations.json` → `node scripts/fill-translations.mjs`.

### WP8 성능·정리 (L)

| # | 파일 | 변경 |
|---|---|---|
| 8.1 | `logs-console.tsx:8` | 읽은 사람 상세(차트 포함)를 `next/dynamic` 으로 펼칠 때만 로드 |
| 8.2 | `devices-console.tsx:37`, `installs-console.tsx:32` | 안 쓰는 `cursorQuery` 제거 |
| 8.3 | `doc-frame.tsx:33` | iframe `load` 마다 옵저버 끊고 현재 body 를 다시 관찰 |
| 8.4 | `journey-form.tsx:92` | 대기 시간 입력은 문자열로 보관, 저장 시 숫자 변환(빈칸 허용) |
| 8.5 | `app/(app)/tester/page.tsx:69` | 브라우저에서 `api-secret` 을 쓰는 이유(관리자 QA 전용) 주석 |

## 구현 기준 (모호한 부분 확정 — 품질 게이트 지적 반영)

- **경로 기준**: 표의 짧은 경로는 `apps/web/src/` 기준(`components/...`, `lib/...`), `app/(app)/...` 는 `apps/web/src/app/(app)/...`. 디자인 규칙 원문은 `apps/web/src/components/ui/button.tsx` 주석과 이 문서의 WP6.
- **기준 커밋**: `7d68c89` + 미커밋 디자인 통일 변경(`ui/button.tsx`, `ui/input.tsx`, `ui/date-picker.tsx`, `layout/*`, 콘솔 21개 파일의 `gap-4`·`overflow-hidden`). 이 변경도 이번 수정과 함께 커밋한다.
- **1.3 발송 순위**: 기간 기준 시각은 `push_logs.created_at`. 기간은 콘솔의 24h/7d/30d 를 지금 `logs` API 와 같은 `from`/`to` 로 보낸다(`from` 포함, `to` 미포함). 읽음률 = `read_count / success_count`, `success_count = 0` 인 발송은 순위에서 제외. 동률은 `success_count` 큰 순 → `created_at` 최신 순. 상위 20건.
- **2.5 "제출한 값과 같을 때만 비움"**: 발송 직전 `{title, body}` 를 저장하고, 성공 응답 시 현재 `{title, body}` 와 둘 다 같으면 비운다.
- **2.6 "아직 아무것도 안 쓴 상태"**: `title`·`body`·`deepLink` 가 모두 빈 문자열이고 커스텀 필드 값·추가 필드가 없을 때. 아니면 `confirmApplyTemplate` 확인을 띄운다.
- **2.9 "드래프트 전체"**: 입력이 바뀔 때마다 올리는 `revision` 숫자를 ref 로 두고, 제출 시점의 revision 과 완료 시점의 revision 이 같을 때만 초기화한다.
- **5.1 포커스 이동**: "내용이 바뀌면"은 **패널 안의 포커스된 요소가 DOM 에서 사라진 경우만**이다(예: 프로젝트 생성 폼 → 발급 키 화면). 입력·검색 결과 갱신으로는 포커스를 옮기지 않는다.
- **3.5 `error.tsx`**: 페이지 컴포넌트 렌더 중 예외만 대상. `(app)/layout.tsx` 자체의 예외는 이 경계가 받지 못하므로 범위 밖(루트 `global-error.tsx` 는 만들지 않음). 합격 기준 7 은 "페이지 예외"로 한정한다.
- **테스트 실행**: `cd apps/web && npx tsc --noEmit && npx vitest run && npx playwright test`. Playwright 는 Docker Postgres(`notikit-postgres-1`)가 떠 있어야 하고 e2e DB(`notikit_e2e`)는 globalSetup 이 마이그레이션한다. 새 e2e 데이터는 각 테스트가 프로젝트를 새로 만들어 준비한다(기존 패턴).
- **bkit 재리뷰**: `bkit:code-analyzer` 로 이 문서의 WP 표에 나온 파일 전부를 본다. HIGH = 데이터가 틀리게 보이거나 사라짐, 중복 요청, 보안, 키보드로 조작 불가.
- **지적 ↔ 작업 대응**: WP 표의 각 행이 한 지적(여러 파일에 같은 원인이면 한 행)에 대응한다. 두 리뷰의 원본 목록은 `sources` 에 적은 두 리뷰이며, 합치면서 뺀 항목은 아래 Do Not Touch / Out of Scope 에 적었다.

## Do Not Touch

- `app/login/page.tsx:64` `max-w-sm`: 앱 셸 밖 로그인 카드. 전체 폭 규칙([[notikit-full-width-content]])은 앱 화면 대상이라 예외로 둔다.
- `layout/header.tsx:159` 드로어 배경 `div onClick`: Esc 처리가 있어 그대로 둔다.
- `send-console.tsx` 치환 미리보기 매 입력 재계산: 입력 상한(255/4000자) 안에서 비용이 무시할 수준.
- 콘솔 API 응답 zod 검증(D4-②): 하지 않는다.
- 직전 커밋의 공통 부품 크기 체계(`button.tsx` 등): 유지, 위반 지점만 고친다.

## Sequencing

```
WP1 서버·보안 ─┐
               ├─> WP2 경쟁·중복 ─> WP3 로딩·오류 ─> WP4 날짜
WP6 디자인 ────┤
WP7 번역 ──────┘   (WP5 접근성은 WP6 과 같은 공통 부품을 만지므로 WP6 직후)
WP8 정리: 아무 때나, 마지막 권장
```

보안(WP1)은 고객사 API 에 영향이 있어 가장 먼저. WP2 는 사용자 데이터가 틀리게 보이는 문제라 그다음.
WP5·WP6 은 `dialog.tsx`·`date-picker.tsx` 를 같이 고치므로 충돌을 피하려 한 번에 이어서 한다.

## Acceptance Criteria

1. `POST /api/v1/messages` 와 콘솔 발송이 `data: { "notikit_log_id": "x" }`, `{ "deep_link": "x" }`, `{ "google.x": "1" }` 에 422 를 돌려준다(템플릿 경유 포함).
2. 참여 화면 발송 순위가 기간(24h/7d/30d)을 바꾸면 그 기간 안 발송만 보인다(e2e 로 기간 밖 발송 제외 확인).
3. 기기·유저·설치·로그 목록에서 "더 보기" 요청 중 필터를 바꿔도 새 필터 결과에 옛 필터 행이 0개 섞인다(단위 또는 e2e).
4. 로그 목록이 50건을 넘으면 "더 보기"로 나머지를 볼 수 있다.
5. 토픽 규칙 저장·삭제 버튼을 연속 2회 클릭해도 요청은 1회 나간다.
6. 상세 화면 3곳(토픽·저니·로그)이 500 응답에서 스켈레톤이 아니라 오류 + 재시도를 보인다.
7. `app/(app)/error.tsx` 가 존재하고, 렌더 중 예외에서 앱 셸(사이드바·헤더)이 남는다.
8. `grep -rnE 'h-5 w-5|h-\[1[78]px\]' src/components/layout` 결과 0건. 따로 서 있는 `<button>` 중 `px-2 py-1` 류 임의 버튼 0건(칸 안 요소 제외, D3).
9. 하드코딩 사용자 문구: `tester`, 웹훅 상태, 저니 단계, `log-only`, 닫기, 차트 표 헤더, 커스텀 필드 placeholder, admin-client 에러 — 모두 next-intl 경유. 23개 언어 파일 누락 키 0.
10. 키보드만으로: 기간 선택(방향키), 사용자 검색 팝업(↑↓·Enter), 다이얼로그 Tab 순환이 배경으로 새지 않음.
11. `npx tsc --noEmit` 0 에러, `vitest` 전부 통과, Playwright e2e 전부 통과(현재 74 + 신규).
12. bkit 재리뷰(code-analyzer)에서 HIGH 0건.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | `messages.ts` 예약 키 거절(직접·템플릿 경유) | +2 |
| Unit | 날짜 → UTC 경계 계산(DST 전후, 4.1) | +2 |
| Integration(API e2e) | 예약 키 422, 참여 순위 기간 필터 | +2 |
| E2E | 필터 전환 중 "더 보기" 섞임 없음(기기) | +1 |
| E2E | 로그 50건 초과 페이지네이션 | +1 |
| E2E | 상세 화면 오류 + 재시도(라우트 가로채 500) | +1 |
| E2E | Segmented 방향키, 사용자 검색 ↑↓·Enter | +2 |

## Rollback Plan

서버 변경은 WP1 한 커밋에 모은다. 고객사에서 예약 키를 보내던 연동이 깨지면 그 커밋만 되돌린다(스키마·DB 변경 없음).
나머지는 WP 단위 커밋이라 WP 별로 revert 가능.

## Effort Estimate (CC 기준)

WP1 20분 · WP2 50분 · WP3 25분 · WP4 15분 · WP5 50분 · WP6 20분 · WP7 30분(번역 포함) · WP8 15분 · 테스트 30분 → 약 4시간.

## Out of Scope

- 콘솔 API 응답 런타임 검증(zod) — D4
- 로그인 화면 폭 제한 해제
- 새 기능, 디자인 체계 자체 변경(직전 커밋 기준 유지)
- 서버 API 중 콘솔이 안 쓰는 부분 리뷰

## 결과 (2026-09-22)

- **실행**: bkit `pdca-iterator` 3개가 파일을 나눠 병렬 수정 → bkit `code-analyzer` 재리뷰 → 재리뷰의 MEDIUM 3건 추가 수정.
- **검증**: `tsc` 0 에러 · web 단위 52 · sdk-core 16 · Playwright e2e **78 통과**(신규: 예약 키 422, 발송 순위 기간, Segmented 방향키, 다이얼로그 포커스). 24개 로케일 누락 키 0.
- **합격 기준 12**: 재리뷰 HIGH **0건** — 충족.
- **문서와 다르게 구현한 것**: 1.3 순위 기준은 `read_count / success_count` 가 아니라 화면의 읽음률과 같은 `clickUserCount / audienceUserCount`. `read_count` 를 올리는 코드가 없어 항상 0이기 때문.
- **재리뷰 후 추가 수정**: M1 좁은 화면 표 셀 라벨(`globals.css` + `data-header-show`), M2 다이얼로그 배경 잠금이 앱 셸 전체를 건너뛰던 문제, M3 콘솔 26개 컴포넌트의 오류 토스트를 `useAdminErrorText` 로 번역, L5 프로젝트 목록 재로딩 스켈레톤 겹침.
- **남은 LOW (다음 작업)**: L1 다이얼로그 2개 겹친 상태에서 아래 것이 먼저 닫히면 배경 잠금 해제 · L2 토픽 규칙 저장 후 재조회 실패 시 토스트 2개 · L3 읽은 사람 로드 실패가 "없음"으로 표시 · L4 웹훅 로드 실패가 "없음"으로 표시 · L6 읽은 사람 표 개수가 불러온 행 수 · L7 빈 대기 시간이 0으로 저장 · L8 저니 저장 가드가 state(동작은 정상).

