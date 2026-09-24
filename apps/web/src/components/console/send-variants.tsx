"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
// 판정 상수는 서버와 한 곳에서 나눠 쓴다 — 어긋나면 화면은 통과시키고 서버가 422 로 막는다
import {
  AB_MIN_VARIANT_SAMPLE,
  AB_SAMPLE_MAX,
  AB_SAMPLE_MIN,
  AB_TIE_MARGIN,
  AB_WAIT_MAX_MINUTES,
  AB_WAIT_MIN_MINUTES,
} from "@/lib/ab-test";
import { CountedLabel } from "./send-content-fields";
import { BODY_RECOMMENDED, TITLE_RECOMMENDED } from "./send-rules";

/** 기본 내용이 변형 A, 여기서 더하는 것이 B 부터 — API 는 변형을 2~5개 받는다 */
export const MAX_EXTRA_VARIANTS = 4;

/** 동률 가드(0.01)를 화면 단위(%p)로 */
const AB_TIE_MARGIN_POINTS = Math.round(AB_TIE_MARGIN * 100);

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
  errors,
  disabled,
}: {
  variants: VariantDraft[];
  onVariants: (v: VariantDraft[]) => void;
  /** 글자 수는 치환된 결과 기준으로 센다 — 기본 내용 카운터와 같은 규칙 */
  render: (tpl: string) => string;
  /**
   * rowId → 비어 있는 칸의 메시지. 변형이 여러 줄이라 "어딘가 비었다"로는 못 고친다 —
   * 빈 칸 바로 아래에 붙이고 aria-invalid 로 표시한다.
   */
  errors?: Record<string, { title?: string; body?: string }>;
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

  /** 새 변형의 첫 칸으로 — 4개째를 더하면 "추가" 버튼이 사라져 포커스가 body 로 떨어진다 */
  const add = () => {
    const next = newVariant();
    pendingFocus.current = `${baseId}-${next.rowId}-title`;
    onVariants([...variants, next]);
  };

  return (
    <div className="space-y-4">
      {variants.map((v, i) => {
        const letter = variantLetter(i + 1);
        const titleId = `${baseId}-${v.rowId}-title`;
        const bodyId = `${baseId}-${v.rowId}-body`;
        const err = errors?.[v.rowId];
        const describedBy = (id: string, message?: string) => (message ? `${id}-count ${id}-error` : `${id}-count`);
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
                aria-describedby={describedBy(titleId, err?.title)}
                aria-invalid={err?.title ? true : undefined}
                value={v.title}
                disabled={disabled}
                onChange={(e) => update(v.rowId, { title: e.target.value })}
                maxLength={255}
                placeholder={t("titlePlaceholder")}
              />
              {err?.title && <p id={`${titleId}-error`} className="text-xs font-semibold text-error">{err.title}</p>}
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
                aria-describedby={describedBy(bodyId, err?.body)}
                aria-invalid={err?.body ? true : undefined}
                className="min-h-24"
                value={v.body}
                disabled={disabled}
                onChange={(e) => update(v.rowId, { body: e.target.value })}
                maxLength={4000}
                placeholder={t("bodyPlaceholder")}
              />
              {err?.body && <p id={`${bodyId}-error`} className="text-xs font-semibold text-error">{err.body}</p>}
            </div>
          </div>
        );
      })}
      {variants.length < MAX_EXTRA_VARIANTS && (
        <div className="flex flex-wrap items-center gap-3">
          <Button ref={addRef} type="button" variant="outline" onClick={add} disabled={disabled}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("addVariant", { letter: nextLetter })}
          </Button>
          <p className="text-xs text-muted-foreground">{t("variantHint")}</p>
        </div>
      )}
    </div>
  );
}

// ─── A/B 자동 승자 ───────────────────────────────────────────────────────────

/** 입력칸은 문자열로 들고 있는다 — 숫자로 바꿔 두면 "비움"과 0 을 구분할 수 없다 */
export type AbTestDraft = { enabled: boolean; samplePercent: string; waitMinutes: string };

export type AbTestPayload = { sample_percent: number; wait_minutes: number };

type AbErrorKey = "errAbSample" | "errAbWait";
export type AbTestErrors = { samplePercent?: AbErrorKey; waitMinutes?: AbErrorKey };

export function emptyAbTest(): AbTestDraft {
  return { enabled: false, samplePercent: "20", waitMinutes: "60" };
}

function intInRange(raw: string, min: number, max: number): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** 초안 → 발송 본문의 `ab_test`. 꺼져 있으면 null 이라 보내지 않는다. */
export function buildAbTest(d: AbTestDraft, enabled: boolean): { value: AbTestPayload | null; errors: AbTestErrors } {
  if (!enabled || !d.enabled) return { value: null, errors: {} };
  const sample = intInRange(d.samplePercent, AB_SAMPLE_MIN, AB_SAMPLE_MAX);
  const wait = intInRange(d.waitMinutes, AB_WAIT_MIN_MINUTES, AB_WAIT_MAX_MINUTES);
  const errors: AbTestErrors = {
    ...(sample === null ? { samplePercent: "errAbSample" as const } : {}),
    ...(wait === null ? { waitMinutes: "errAbWait" as const } : {}),
  };
  if (sample === null || wait === null) return { value: null, errors };
  return { value: { sample_percent: sample, wait_minutes: wait }, errors };
}

export function hasAbTestErrors(e: AbTestErrors): boolean {
  return Boolean(e.samplePercent || e.waitMinutes);
}

/**
 * A/B 자동 승자 설정 — 표본 비율과 판정 대기.
 *
 * 지표(유니크 클릭률)는 고르게 하지 않는다: 고를 수 있으면 판정 규칙이 지표마다 갈라지고,
 * 무엇으로 이겼는지 나중에 읽는 사람이 매번 확인해야 한다.
 * 최소 표본·동률 가드는 미리 문장으로 밝힌다 — 승자가 안 나왔을 때 "고장"으로 읽히지 않게.
 */
export function SendAbTestFields({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: AbTestDraft;
  onChange: (v: AbTestDraft) => void;
  errors: AbTestErrors;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const toggleId = React.useId();
  const set = (patch: Partial<AbTestDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <input
          id={toggleId}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          checked={value.enabled}
          disabled={disabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <div className="min-w-0 space-y-1">
          <label htmlFor={toggleId} className="block text-xs font-semibold text-foreground">{t("abTestLabel")}</label>
          <p className="text-xs text-muted-foreground">{t("abTestHint")}</p>
        </div>
      </div>

      {value.enabled && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <Field
              label={t("abSampleLabel")}
              error={errors.samplePercent ? t(errors.samplePercent, { min: AB_SAMPLE_MIN, max: AB_SAMPLE_MAX }) : null}
              className="min-w-40 flex-1"
            >
              <Input
                inputMode="numeric"
                value={value.samplePercent}
                disabled={disabled}
                onChange={(e) => set({ samplePercent: e.target.value })}
                placeholder="20"
              />
            </Field>
            <Field
              label={t("abWaitLabel")}
              error={errors.waitMinutes ? t(errors.waitMinutes, { min: AB_WAIT_MIN_MINUTES, max: AB_WAIT_MAX_MINUTES }) : null}
              className="min-w-40 flex-1"
            >
              <Input
                inputMode="numeric"
                value={value.waitMinutes}
                disabled={disabled}
                onChange={(e) => set({ waitMinutes: e.target.value })}
                placeholder="60"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("abTestNotice", { min: AB_MIN_VARIANT_SAMPLE, margin: AB_TIE_MARGIN_POINTS })}
          </p>
        </div>
      )}
    </div>
  );
}
