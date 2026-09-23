"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { CountedLabel } from "./send-content-fields";
import { BODY_RECOMMENDED, TITLE_RECOMMENDED } from "./send-rules";

/** 기본 내용이 변형 A, 여기서 더하는 것이 B 부터 — API 는 변형을 2~5개 받는다 */
export const MAX_EXTRA_VARIANTS = 4;

export type VariantDraft = { rowId: string; title: string; body: string };

export function variantLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function newVariant(): VariantDraft {
  return { rowId: newRowId(), title: "", body: "" };
}

/**
 * A/B 변형 편집기 — 기본 제목·본문(A) 아래에 B, C… 를 더한다.
 * 수신자는 서버에서 토큰 해시로 변형에 고르게 배정된다.
 */
export function SendVariantFields({
  variants,
  onVariants,
  render,
  disabled,
}: {
  variants: VariantDraft[];
  onVariants: (v: VariantDraft[]) => void;
  /** 글자 수는 치환된 결과 기준으로 센다 — 기본 내용 카운터와 같은 규칙 */
  render: (tpl: string) => string;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const baseId = React.useId();
  const update = (rowId: string, patch: Partial<VariantDraft>) =>
    onVariants(variants.map((v) => (v.rowId === rowId ? { ...v, ...patch } : v)));
  const nextLetter = variantLetter(variants.length + 1);
  const addRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocus = React.useRef<string | null>(null);

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = target ? document.getElementById(target) : null;
    (el ?? addRef.current)?.focus();
  }, [variants]);

  const remove = (index: number) => {
    const prev = index > 0 ? variants[index - 1] : undefined;
    pendingFocus.current = prev ? `${baseId}-${prev.rowId}-title` : "";
    onVariants(variants.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {variants.map((v, i) => {
        const letter = variantLetter(i + 1);
        const titleId = `${baseId}-${v.rowId}-title`;
        const bodyId = `${baseId}-${v.rowId}-body`;
        return (
          <div key={v.rowId} role="group" aria-labelledby={`${baseId}-${v.rowId}-name`} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p id={`${baseId}-${v.rowId}-name`} className="text-xs font-semibold text-foreground">{t("variantLegend", { letter })}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeVariant", { letter })}
                onClick={() => remove(i)}
                disabled={disabled}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              <CountedLabel
                htmlFor={titleId}
                label={t("variantTitleLabel", { letter })}
                counterId={`${titleId}-count`}
                value={render(v.title)}
                max={TITLE_RECOMMENDED}
              />
              <Input
                id={titleId}
                aria-describedby={`${titleId}-count`}
                value={v.title}
                disabled={disabled}
                onChange={(e) => update(v.rowId, { title: e.target.value })}
                maxLength={255}
                placeholder={t("titlePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <CountedLabel
                htmlFor={bodyId}
                label={t("variantBodyLabel", { letter })}
                counterId={`${bodyId}-count`}
                value={render(v.body)}
                max={BODY_RECOMMENDED}
              />
              <Textarea
                id={bodyId}
                aria-describedby={`${bodyId}-count`}
                className="min-h-24"
                value={v.body}
                disabled={disabled}
                onChange={(e) => update(v.rowId, { body: e.target.value })}
                maxLength={4000}
                placeholder={t("bodyPlaceholder")}
              />
            </div>
          </div>
        );
      })}
      {variants.length < MAX_EXTRA_VARIANTS && (
        <div className="flex flex-wrap items-center gap-3">
          <Button ref={addRef} type="button" variant="outline" onClick={() => onVariants([...variants, newVariant()])} disabled={disabled}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("addVariant", { letter: nextLetter })}
          </Button>
          <p className="text-xs text-muted-foreground">{t("variantHint")}</p>
        </div>
      )}
    </div>
  );
}
