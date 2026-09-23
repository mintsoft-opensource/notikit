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
