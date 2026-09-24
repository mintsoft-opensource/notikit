/**
 * 감사 로그의 **순수** 부분 — 상수·타입·표시용 헬퍼.
 *
 * 콘솔(클라이언트 컴포넌트)이 `audit.ts` 를 바로 끌어오면 `@/db/client` 가 따라 들어와
 * 클라이언트 번들이 깨진다(journey-triggers → journey-steps 분리와 같은 이유).
 * DB 를 건드리지 않는 것만 여기 둔다.
 */

/** 감사 대상 종류 */
export const AUDIT_TARGET_TYPES = [
  "project",
  "topic",
  "suppression",
  "suppression_batch",
  "schedule",
  "webhook",
  "member",
  "send",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * 기록하는 행위 목록. 화면의 필터 드롭다운이 이 목록을 그대로 쓴다 —
 * 목록에 없는 action 을 기록하면 필터로는 못 찾고 전체 목록에서만 보인다.
 */
export const AUDIT_ACTIONS = [
  "project.settings.update",
  "topic.create",
  "topic.update",
  "topic.delete",
  "suppression.create",
  "suppression.update",
  "suppression.delete",
  "suppression.import",
  "suppression.import.revert",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "webhook.create",
  "member.create",
  "member.update",
  "member.delete",
  "send.create",
  "send.cancel",
  "send.purge",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * 거부된 시도의 접미사. 성공만 적으면 "누가 이걸 바꾸려다 막혔는가" 를 영영 못 본다 —
 * 권한 오남용은 대개 성공한 변경이 아니라 막힌 시도에서 먼저 보인다.
 *
 * 별도 action 을 두지 않고 접미사로 붙이는 이유: 필터에서 기본 action 하나만 골라도
 * 성공과 거부가 함께 보여야 한다.
 */
export const DENIED_SUFFIX = ":denied";

export type DiffEntry = { before: unknown; after: unknown };
/** 필드별 변경 전/후. "updated" 만 적고 값이 없으면 감사 로그가 아니라 알림이다. */
export type AuditDiff = Record<string, DiffEntry>;

/** 목록 API 가 내려주는 한 건 */
export type AuditEntryDto = {
  id: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: AuditDiff | null;
  createdAt: string;
};

/** 화면 표시용 — 거부된 시도인가 */
export function isDenied(action: string): boolean {
  return action.endsWith(DENIED_SUFFIX);
}

/** 화면 표시용 — 접미사를 뗀 기본 action */
export function baseAction(action: string): string {
  return isDenied(action) ? action.slice(0, -DENIED_SUFFIX.length) : action;
}

/** 필터용 — 고른 action 하나로 성공과 거부를 함께 본다. */
export function actionFilter(action: string): string[] {
  return [action, `${action}${DENIED_SUFFIX}`];
}
