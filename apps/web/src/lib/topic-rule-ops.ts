export const RULE_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;
export type RuleOp = (typeof RULE_OPS)[number];
export const NUMERIC_OPS: readonly RuleOp[] = ["gt", "gte", "lt", "lte"];

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function isNumericOp(op: RuleOp | undefined): boolean {
  return Boolean(op && NUMERIC_OPS.includes(op));
}

export function isNumericValue(v: string): boolean {
  return NUMERIC_RE.test(v.trim());
}

/**
 * 행동 규칙이 보는 곳 — 이미 쌓고 있는 네 종류의 기록.
 *
 * - `click`      push_clicks       알림을 탭했다
 * - `conversion` push_conversions  클릭에 귀속된 앱 안 행동(이름으로 가른다)
 * - `activity`   device_activity   앱을 열었다(일 단위 롤업)
 * - `send`       push_user_sends   발송을 받았다(빈도 상한이 켜진 프로젝트에서만 쌓인다)
 */
export const BEHAVIOR_SOURCES = ["click", "conversion", "activity", "send"] as const;
export type BehaviorSource = (typeof BEHAVIOR_SOURCES)[number];

export const BEHAVIOR_OPS = ["within_days", "not_within_days", "count_gte"] as const;
export type BehaviorOp = (typeof BEHAVIOR_OPS)[number];

/** 기간 상한 — 이보다 긴 창은 "전체 기간"과 다르지 않고, 인덱스를 타도 훑는 범위만 커진다 */
export const MAX_BEHAVIOR_DAYS = 365;
export const MAX_BEHAVIOR_COUNT = 10_000;

/** `op` 가 없으면 eq — 연산자 도입 전에 저장된 규칙이 그대로 동작한다. */
export type AttributeRule = { attribute: string; op?: RuleOp; value: string };

/** 기간(days)은 within/not_within 에 필수, count_gte 에는 선택(없으면 전체 기간). */
export type BehaviorRule = {
  source: BehaviorSource;
  op: BehaviorOp;
  days?: number;
  count?: number;
  /** 전환 이름 — conversion 에만 쓴다 */
  name?: string;
};

/**
 * 토픽 규칙 — 속성 규칙과 행동 규칙의 유니온.
 *
 * 속성 규칙의 모양은 손대지 않았다. 이미 저장된 토픽의 jsonb 가 그대로 이 유니온의
 * 한쪽이 되어야 마이그레이션 없이 계속 동작한다.
 */
export type TopicRule = AttributeRule | BehaviorRule;

export function isBehaviorRule(r: TopicRule): r is BehaviorRule {
  return "source" in r;
}

/** 기간이 반드시 있어야 하는 연산자 — count_gte 의 기간은 선택이다 */
export function needsDays(op: BehaviorOp): boolean {
  return op === "within_days" || op === "not_within_days";
}

/** 전환만 이름을 가른다 — 클릭·접속·발송에는 이름이 없다 */
export function supportsName(source: BehaviorSource): boolean {
  return source === "conversion";
}

export function isIntInRange(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

/**
 * 이 행동 규칙을 SQL 로 옮겨도 되는가.
 *
 * 저장 경로는 zod 가 막지만, 오래된 행이나 직접 UPDATE 로 반쪽짜리 규칙이 들어올 수 있다.
 * 그때 조건을 조용히 빼면 **대상이 넓어진다** — 특히 not_within_days 에서 기간이 빠지면
 * "한 번도 하지 않은 사람 전부"가 되어 세그먼트가 프로젝트 전체로 부푼다. 그래서
 * 온전하지 않은 규칙은 아무도 맞지 않게 한다(isNumericValue 가드와 같은 방향).
 */
export function isBehaviorUsable(r: BehaviorRule): boolean {
  if (!BEHAVIOR_SOURCES.includes(r.source) || !BEHAVIOR_OPS.includes(r.op)) return false;
  if (r.days !== undefined && !isIntInRange(r.days, 1, MAX_BEHAVIOR_DAYS)) return false;
  if (needsDays(r.op) && r.days === undefined) return false;
  if (r.op === "count_gte" && !isIntInRange(r.count, 1, MAX_BEHAVIOR_COUNT)) return false;
  return true;
}
