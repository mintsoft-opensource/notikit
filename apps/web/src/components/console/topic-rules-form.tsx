"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_ERROR_TEXT, FIELD_HINT_TEXT, Input, Select } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import {
  BEHAVIOR_OPS,
  BEHAVIOR_SOURCES,
  MAX_BEHAVIOR_COUNT,
  MAX_BEHAVIOR_DAYS,
  RULE_OPS,
  isBehaviorRule,
  isNumericOp,
  isNumericValue,
  needsDays,
  supportsName,
  type BehaviorOp,
  type BehaviorSource,
  type RuleOp,
  type TopicRule,
} from "@/lib/topic-rule-ops";

export type Rule = TopicRule;

/** 첫 번째 셀렉트가 고르는 것 — 유저 속성을 볼지, 어떤 행동 기록을 볼지 */
type Subject = "attribute" | BehaviorSource;

/**
 * 편집 중인 조건 — rowId 는 화면 key 용이고 저장할 때(cleanRules) 빠진다.
 *
 * 속성 쪽과 행동 쪽 값을 **둘 다** 들고 있는다. 유니온으로 두면 종류를 바꿀 때마다
 * 반대쪽 입력이 사라져, 잘못 고른 걸 되돌리면 방금 친 값이 날아간다.
 * 숫자도 문자열로 들고 있는다 — 지우는 도중의 빈 칸을 0 으로 되돌리지 않기 위해서다.
 */
export type RuleDraft = {
  rowId: string;
  subject: Subject;
  attribute: string;
  op: RuleOp;
  value: string;
  behaviorOp: BehaviorOp;
  days: string;
  count: string;
  name: string;
};

const BLANK: Omit<RuleDraft, "rowId"> = {
  subject: "attribute",
  attribute: "",
  op: "eq",
  value: "",
  behaviorOp: "within_days",
  days: "",
  count: "",
  name: "",
};

export function toRuleDrafts(rules: Rule[]): RuleDraft[] {
  return rules.map((r) => {
    if (!isBehaviorRule(r)) {
      return { ...BLANK, rowId: newRowId(), attribute: r.attribute, op: r.op ?? "eq", value: r.value };
    }
    return {
      ...BLANK,
      rowId: newRowId(),
      subject: r.source,
      behaviorOp: r.op,
      days: r.days === undefined ? "" : String(r.days),
      count: r.count === undefined ? "" : String(r.count),
      name: r.name ?? "",
    };
  });
}

/** 빈 조건 한 줄로 시작하는 드래프트 — 행마다 새 id 가 필요해 상수가 아니라 함수다 */
export function emptyRules(): RuleDraft[] {
  return [{ ...BLANK, rowId: newRowId() }];
}

/** 이 행에 뭔가 입력했는가 — 저장하지 않고 닫을 때 물어볼지 판단한다 */
export function isRuleDraftDirty(r: RuleDraft): boolean {
  if (r.subject !== "attribute") return true;
  return Boolean(r.attribute.trim() || r.value.trim());
}

/** 정수 칸 하나의 상태. 비어 있음과 범위 밖을 갈라야 "필수"와 "잘못됨"을 다르게 말한다. */
function intState(raw: string, min: number, max: number): "empty" | "ok" | "bad" {
  const v = raw.trim();
  if (!v) return "empty";
  return /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? "ok" : "bad";
}

type RowErrors = { value?: boolean; days?: boolean; count?: boolean };

/** 화면에 빨갛게 보여 줄 칸 — 아직 안 채운 칸은 오류가 아니다(입력 중이다) */
function rowErrors(r: RuleDraft): RowErrors {
  if (r.subject === "attribute") {
    return { value: isNumericOp(r.op) && r.value.trim() !== "" && !isNumericValue(r.value) };
  }
  return {
    days: intState(r.days, 1, MAX_BEHAVIOR_DAYS) === "bad",
    count: r.behaviorOp === "count_gte" && intState(r.count, 1, MAX_BEHAVIOR_COUNT) === "bad",
  };
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

  const update = (rowId: string, patch: Partial<RuleDraft>) =>
    onRules(rules.map((x) => (x.rowId === rowId ? { ...x, ...patch } : x)));

  const remove = (index: number) => {
    const rest = rules.filter((_, i) => i !== index);
    pendingFocus.current = rest[Math.max(0, index - 1)]?.rowId ?? "";
    onRules(rest);
  };

  const add = () => {
    const row = { ...BLANK, rowId: newRowId() };
    // 새 행의 첫 칸으로 간다 — 추가 버튼에 초점이 남으면 어디에 쓰는지 안 보인다
    pendingFocus.current = row.rowId;
    onRules([...rules, row]);
  };

  return (
    <div role="group" aria-labelledby={headingId} className="w-full space-y-4">
      <p id={headingId} className="text-xs font-semibold text-foreground">{t("rulesLabel")}</p>
      {rules.map((r, i) => {
        const err = rowErrors(r);
        const behavior = r.subject !== "attribute";
        const errorId = `${idPrefix}-${r.rowId}-error`;
        const daysErrorId = `${idPrefix}-${r.rowId}-days-error`;
        const countErrorId = `${idPrefix}-${r.rowId}-count-error`;
        return (
          <div key={r.rowId} role="group" aria-label={t("ruleRowLabel", { n: i + 1 })} className="space-y-2">
            <div className="flex w-full flex-wrap items-center gap-4">
              <Select
                aria-label={t("ruleSubjectLabel")}
                value={r.subject}
                onChange={(e) => update(r.rowId, { subject: e.target.value as Subject })}
                disabled={disabled}
                className="w-auto min-w-36"
              >
                <option value="attribute">{t("ruleSubjectAttribute")}</option>
                {BEHAVIOR_SOURCES.map((s) => (
                  <option key={s} value={s}>{t(`ruleSource_${s}`)}</option>
                ))}
              </Select>

              {!behavior && (
                <>
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
                    className="min-w-36 flex-1"
                  />
                  <Select
                    aria-label={t("ruleOpLabel")}
                    value={r.op}
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
                    aria-invalid={err.value ? true : undefined}
                    aria-describedby={err.value ? errorId : undefined}
                    disabled={disabled}
                    className="min-w-36 flex-1"
                  />
                </>
              )}

              {behavior && (
                <>
                  <Select
                    aria-label={t("ruleBehaviorOpLabel")}
                    value={r.behaviorOp}
                    onChange={(e) => update(r.rowId, { behaviorOp: e.target.value as BehaviorOp })}
                    disabled={disabled}
                    className="w-auto min-w-44"
                  >
                    {BEHAVIOR_OPS.map((op) => (
                      <option key={op} value={op}>{t(`ruleBehaviorOp_${op}`)}</option>
                    ))}
                  </Select>
                  {r.behaviorOp === "count_gte" && (
                    <Input
                      aria-label={t("ruleCountLabel")}
                      value={r.count}
                      onChange={(e) => update(r.rowId, { count: e.target.value })}
                      placeholder={t("ruleCountPlaceholder")}
                      inputMode="numeric"
                      aria-invalid={err.count ? true : undefined}
                      aria-describedby={err.count ? countErrorId : undefined}
                      disabled={disabled}
                      className="w-24"
                    />
                  )}
                  <Input
                    ref={(el) => {
                      if (el) inputRefs.current.set(r.rowId, el);
                      else inputRefs.current.delete(r.rowId);
                    }}
                    aria-label={t("ruleDaysLabel")}
                    value={r.days}
                    onChange={(e) => update(r.rowId, { days: e.target.value })}
                    placeholder={needsDays(r.behaviorOp) ? t("ruleDaysPlaceholder") : t("ruleDaysAnyPlaceholder")}
                    inputMode="numeric"
                    aria-invalid={err.days ? true : undefined}
                    aria-describedby={err.days ? daysErrorId : undefined}
                    disabled={disabled}
                    className="w-28"
                  />
                  {supportsName(r.subject as BehaviorSource) && (
                    <Input
                      aria-label={t("ruleConversionNameLabel")}
                      value={r.name}
                      onChange={(e) => update(r.rowId, { name: e.target.value })}
                      placeholder={t("ruleConversionNamePlaceholder")}
                      disabled={disabled}
                      className="min-w-36 flex-1"
                    />
                  )}
                </>
              )}

              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeRule")}
                onClick={() => remove(i)}
                disabled={disabled || rules.length === 1}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            {err.value && <p id={errorId} className={FIELD_ERROR_TEXT}>{t("ruleNeedNumber")}</p>}
            {err.days && (
              <p id={daysErrorId} className={FIELD_ERROR_TEXT}>{t("ruleNeedDays", { max: MAX_BEHAVIOR_DAYS })}</p>
            )}
            {err.count && (
              <p id={countErrorId} className={FIELD_ERROR_TEXT}>{t("ruleNeedCount", { max: MAX_BEHAVIOR_COUNT })}</p>
            )}
          </div>
        );
      })}
      <Button ref={addRef} type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus aria-hidden="true" className="size-4" /> {t("addRule")}
      </Button>
      <p className={FIELD_HINT_TEXT}>{t("rulesHintOps")}</p>
      <p className={FIELD_HINT_TEXT}>{t("rulesHintBehavior")}</p>
    </div>
  );
}

export type CleanRuleMessages = {
  partial: string;
  needRule: string;
  needNumber?: string;
  needDays?: string;
  needCount?: string;
};

/**
 * 저장 전 규칙 정리. 반환이 null 이면 호출측은 저장하지 않는다.
 *
 * 한쪽만 채운 규칙을 조용히 버리면 **대상이 의도보다 넓어진다** — 규칙 하나가 사라지면
 * 그만큼 더 많은 유저에게 발송된다. 그래서 버리지 않고 막는다. 행동 규칙도 같다:
 * 기간이 빠진 "최근 N일 안에 안 했음"은 "한 번도 안 했음"이 되어 대상이 부푼다.
 *
 * 규칙 0개도 막는다. 조건이 없으면 전원이 대상이라, 그룹을 만들었는데 전체 발송이 된다.
 * 전체 발송은 broadcast 로 따로 있다.
 */
export function cleanRules(
  rules: RuleDraft[],
  msg: CleanRuleMessages,
  onError: (m: string) => void
): Rule[] | null {
  const attrs = rules.filter((r) => r.subject === "attribute");
  const behaviors = rules.filter((r) => r.subject !== "attribute");

  if (attrs.some((r) => Boolean(r.attribute.trim()) !== Boolean(r.value.trim()))) {
    onError(msg.partial);
    return null;
  }
  if (attrs.some((r) => isNumericOp(r.op) && r.value.trim() && !isNumericValue(r.value))) {
    onError(msg.needNumber ?? msg.partial);
    return null;
  }
  for (const r of behaviors) {
    const days = intState(r.days, 1, MAX_BEHAVIOR_DAYS);
    if (days === "bad" || (needsDays(r.behaviorOp) && days === "empty")) {
      onError(msg.needDays ?? msg.partial);
      return null;
    }
    if (r.behaviorOp === "count_gte" && intState(r.count, 1, MAX_BEHAVIOR_COUNT) !== "ok") {
      onError(msg.needCount ?? msg.partial);
      return null;
    }
  }

  const cleaned: Rule[] = [];
  for (const r of rules) {
    if (r.subject === "attribute") {
      if (!r.attribute.trim() || !r.value.trim()) continue;
      cleaned.push({ attribute: r.attribute.trim(), op: r.op, value: r.value.trim() });
      continue;
    }
    const days = r.days.trim();
    const name = r.name.trim();
    cleaned.push({
      source: r.subject,
      op: r.behaviorOp,
      ...(days ? { days: Number(days) } : {}),
      ...(r.behaviorOp === "count_gte" ? { count: Number(r.count.trim()) } : {}),
      ...(supportsName(r.subject) && name ? { name } : {}),
    });
  }
  if (cleaned.length === 0) {
    onError(msg.needRule);
    return null;
  }
  return cleaned;
}
