"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { RULE_OPS, isNumericOp, isNumericValue, type RuleOp } from "@/lib/topic-rule-ops";

export type Rule = { attribute: string; op?: RuleOp; value: string };

/** 편집 중인 조건 — rowId 는 화면 key 용이고 저장할 때(cleanRules) 빠진다 */
export type RuleDraft = Rule & { rowId: string };

export function toRuleDrafts(rules: Rule[]): RuleDraft[] {
  return rules.map((r) => ({ attribute: r.attribute, op: r.op ?? "eq", value: r.value, rowId: newRowId() }));
}

/** 빈 조건 한 줄로 시작하는 드래프트 — 행마다 새 id 가 필요해 상수가 아니라 함수다 */
export function emptyRules(): RuleDraft[] {
  return toRuleDrafts([{ attribute: "", value: "" }]);
}

/**
 * 규칙식 그룹의 조건 편집기 — 생성 모달과 수정 화면이 **같은 컴포넌트**를 쓴다.
 *
 * 따로 두면 한쪽에만 규칙이 추가되어 "생성은 되는데 수정하면 검증이 다른" 상태가 된다.
 * 검증도 아래 cleanRules 한 곳에 둔다.
 */
export function TopicRuleFields({
  rules,
  onRules,
  idPrefix,
  disabled = false,
}: {
  rules: RuleDraft[];
  onRules: (v: RuleDraft[]) => void;
  idPrefix: string;
  /** 저장 중에는 편집을 막는다 — 완료 후 서버 값으로 되맞출 때 그사이 고친 조건이 사라진다 */
  disabled?: boolean;
}) {
  const t = useTranslations("audience");
  const headingId = React.useId();
  const inputRefs = React.useRef(new Map<string, HTMLInputElement>());
  const addRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocus = React.useRef<string | null>(null);

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    (inputRefs.current.get(target) ?? addRef.current)?.focus();
  }, [rules]);

  const update = (rowId: string, patch: Partial<Rule>) =>
    onRules(rules.map((x) => (x.rowId === rowId ? { ...x, ...patch } : x)));

  const remove = (index: number) => {
    const rest = rules.filter((_, i) => i !== index);
    pendingFocus.current = rest[Math.max(0, index - 1)]?.rowId ?? "";
    onRules(rest);
  };

  return (
    <div role="group" aria-labelledby={headingId} className="space-y-2">
      <p id={headingId} className="text-xs font-semibold text-foreground">{t("rulesLabel")}</p>
      {rules.map((r, i) => {
        const invalid = isNumericOp(r.op) && r.value.trim() !== "" && !isNumericValue(r.value);
        const errorId = `${idPrefix}-${r.rowId}-error`;
        return (
          <div key={r.rowId} role="group" aria-label={t("ruleRowLabel", { n: i + 1 })} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Input
                ref={(el) => {
                  if (el) inputRefs.current.set(r.rowId, el);
                  else inputRefs.current.delete(r.rowId);
                }}
                id={i === 0 ? `${idPrefix}-attribute` : undefined}
                aria-label={t("ruleAttributeLabel")}
                value={r.attribute}
                onChange={(e) => update(r.rowId, { attribute: e.target.value })}
                placeholder={t("attributePlaceholder")}
                disabled={disabled}
              />
              <Select
                aria-label={t("ruleOpLabel")}
                value={r.op ?? "eq"}
                onChange={(e) => update(r.rowId, { op: e.target.value as RuleOp })}
                disabled={disabled}
                className="w-auto min-w-32"
              >
                {RULE_OPS.map((op) => (
                  <option key={op} value={op}>{t(`ruleOp_${op}`)}</option>
                ))}
              </Select>
              <Input
                aria-label={t("ruleValueLabel")}
                value={r.value}
                onChange={(e) => update(r.rowId, { value: e.target.value })}
                placeholder={t("valuePlaceholder")}
                inputMode={isNumericOp(r.op) ? "decimal" : undefined}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? errorId : undefined}
                disabled={disabled}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeRule")}
                onClick={() => remove(i)}
                disabled={disabled || rules.length === 1}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            {invalid && <p id={errorId} className="text-xs text-error">{t("ruleNeedNumber")}</p>}
          </div>
        );
      })}
      <Button ref={addRef} type="button" variant="outline" size="sm" onClick={() => onRules([...rules, ...emptyRules()])} disabled={disabled}>
        <Plus aria-hidden="true" className="h-4 w-4" /> {t("addRule")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("rulesHintOps")}</p>
    </div>
  );
}

/**
 * 저장 전 규칙 정리. 반환이 null 이면 호출측은 저장하지 않는다.
 *
 * 한쪽만 채운 규칙을 조용히 버리면 **대상이 의도보다 넓어진다** — 규칙 하나가 사라지면
 * 그만큼 더 많은 유저에게 발송된다. 그래서 버리지 않고 막는다.
 *
 * 규칙 0개도 막는다. 조건이 없으면 전원이 대상이라, 그룹을 만들었는데 전체 발송이 된다.
 * 전체 발송은 broadcast 로 따로 있다.
 */
export function cleanRules(
  rules: Rule[],
  msg: { partial: string; needRule: string; needNumber?: string },
  onError: (m: string) => void
): Rule[] | null {
  if (rules.some((r) => Boolean(r.attribute.trim()) !== Boolean(r.value.trim()))) {
    onError(msg.partial);
    return null;
  }
  if (rules.some((r) => isNumericOp(r.op) && r.value.trim() && !isNumericValue(r.value))) {
    onError(msg.needNumber ?? msg.partial);
    return null;
  }
  const cleaned = rules
    .filter((r) => r.attribute.trim() && r.value.trim())
    .map((r) => ({ attribute: r.attribute.trim(), op: r.op ?? "eq", value: r.value.trim() }));
  if (cleaned.length === 0) {
    onError(msg.needRule);
    return null;
  }
  return cleaned;
}
