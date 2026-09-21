"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export type Rule = { attribute: string; value: string };

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
}: {
  rules: Rule[];
  onRules: (v: Rule[]) => void;
  idPrefix: string;
}) {
  const t = useTranslations("audience");

  return (
    <div className="space-y-2">
      <Label>{t("rulesLabel")}</Label>
      {rules.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            id={i === 0 ? `${idPrefix}-attribute` : undefined}
            aria-label={t("attributePlaceholder")}
            value={r.attribute}
            onChange={(e) => onRules(rules.map((x, j) => (j === i ? { ...x, attribute: e.target.value } : x)))}
            placeholder={t("attributePlaceholder")}
          />
          <span className="text-muted-foreground">=</span>
          <Input
            aria-label={t("valuePlaceholder")}
            value={r.value}
            onChange={(e) => onRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            placeholder={t("valuePlaceholder")}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("removeRule")}
            onClick={() => onRules(rules.filter((_, j) => j !== i))}
            disabled={rules.length === 1}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onRules([...rules, { attribute: "", value: "" }])}>
        <Plus aria-hidden="true" className="h-4 w-4" /> {t("addRule")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("rulesHint")}</p>
    </div>
  );
}

export const EMPTY_RULES: Rule[] = [{ attribute: "", value: "" }];

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
  msg: { partial: string; needRule: string },
  onError: (m: string) => void
): Rule[] | null {
  if (rules.some((r) => Boolean(r.attribute.trim()) !== Boolean(r.value.trim()))) {
    onError(msg.partial);
    return null;
  }
  const cleaned = rules
    .filter((r) => r.attribute.trim() && r.value.trim())
    .map((r) => ({ attribute: r.attribute.trim(), value: r.value.trim() }));
  if (cleaned.length === 0) {
    onError(msg.needRule);
    return null;
  }
  return cleaned;
}
