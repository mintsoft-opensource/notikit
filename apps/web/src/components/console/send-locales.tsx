"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Languages, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Field, Input, Textarea } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { LOCALE_DEFAULT_KEY, MAX_LOCALE_VARIANTS, isLocaleKey, normalizeLocaleTag } from "@/lib/locale-content";

/**
 * 로케일별 문구 — 한 발송이 `{ default, ko, ja-JP, … }` 를 들고 다니다 fan-out 때 고른다.
 *
 * 판정 규칙은 `lib/locale-content` 를 **그대로** 쓴다(그 파일은 db 를 끌어오지 않는다).
 * 화면이 따로 판정하면 콘솔은 통과시키고 서버가 422 로 막는 칸이 생긴다.
 */
export type LocaleRowDraft = { rowId: string; tag: string; title: string; body: string };

export type LocalePayload = Record<string, { title: string; body: string }>;

type ErrorKey = "errLocaleTag" | "errLocaleDup" | "errLocaleText";

export type SendLocaleErrors = {
  rows: Record<string, ErrorKey>;
  /** 변형(A/B)과 함께 쓰려 한 경우 — 서버 `localeVariantsError` 와 같은 규칙 */
  withVariants?: boolean;
};

const TITLE_MAX = 255;
const BODY_MAX = 4000;

export function newLocaleRow(tag = ""): LocaleRowDraft {
  return { rowId: newRowId(), tag, title: "", body: "" };
}

function rowBlank(r: LocaleRowDraft): boolean {
  return !r.tag.trim() && !r.title.trim() && !r.body.trim();
}

/**
 * 초안 → 발송 본문의 `locales`. 아무 줄도 없으면 undefined —
 * 빈 객체를 보내면 서버가 "locales must not be empty" 로 422 를 준다.
 */
export function buildLocales(
  rows: LocaleRowDraft[],
  hasVariants: boolean
): { locales?: LocalePayload; errors: SendLocaleErrors } {
  const errors: SendLocaleErrors = { rows: {} };
  const filled = rows.filter((r) => !rowBlank(r));
  if (filled.length === 0) return { errors };

  // 두 축을 곱하면 운영자가 변형 × 로케일을 전부 채워야 하고, 빈 칸 하나가 기본 문구로
  // 떨어질 때 그게 어느 축의 폴백인지 구분할 수 없다 — 서버도 같은 이유로 422 다
  if (hasVariants) return { errors: { rows: {}, withVariants: true } };

  const out: LocalePayload = {};
  const seen = new Set<string>();
  for (const r of filled) {
    const tag = r.tag.trim();
    if (!isLocaleKey(tag)) {
      errors.rows[r.rowId] = "errLocaleTag";
      continue;
    }
    // "ko_KR" 과 "ko-KR" 은 같은 언어다 — 둘 다 받으면 어느 쪽이 이기는지 입력만 보고 알 수 없다
    const norm = tag === LOCALE_DEFAULT_KEY ? LOCALE_DEFAULT_KEY : normalizeLocaleTag(tag);
    if (seen.has(norm)) {
      errors.rows[r.rowId] = "errLocaleDup";
      continue;
    }
    if (!r.title.trim() || !r.body.trim()) {
      errors.rows[r.rowId] = "errLocaleText";
      continue;
    }
    seen.add(norm);
    out[tag] = { title: r.title.trim(), body: r.body.trim() };
  }
  return { locales: Object.keys(out).length > 0 ? out : undefined, errors };
}

export function hasLocaleErrors(e: SendLocaleErrors): boolean {
  return Boolean(e.withVariants) || Object.keys(e.rows).length > 0;
}

export function countLocales(rows: LocaleRowDraft[]): number {
  return rows.filter((r) => !rowBlank(r)).length;
}

/**
 * 로케일 문구 칸 — 줄마다 언어 태그 + 제목 + 본문.
 *
 * 줄을 더하거나 지우면 누르고 있던 버튼이 사라진다 — 그대로 두면 포커스가 body 로 떨어져
 * 키보드 사용자는 처음부터 다시 훑어야 한다(send-options·topic-rules-form 과 같은 방식).
 */
export function SendLocaleFields({
  rows,
  onRows,
  errors,
  hasVariants,
  disabled,
}: {
  rows: LocaleRowDraft[];
  onRows: (v: LocaleRowDraft[]) => void;
  errors: SendLocaleErrors;
  hasVariants: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const groupId = React.useId();

  const tagInputRefs = React.useRef(new Map<string, HTMLInputElement>());
  const addRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocus = React.useRef<string | null>(null);
  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    (tagInputRefs.current.get(target) ?? addRef.current)?.focus();
  }, [rows]);

  const setRow = (rowId: string, patch: Partial<LocaleRowDraft>) =>
    onRows(rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));

  const add = () => {
    // 첫 줄은 기본 문구다 — 기본 없이 보내면 맞는 언어가 없는 사람에게 발송 본문이 그대로 간다
    const next = newLocaleRow(rows.length === 0 ? LOCALE_DEFAULT_KEY : "");
    pendingFocus.current = next.rowId;
    onRows([...rows, next]);
  };
  const remove = (index: number) => {
    const rest = rows.filter((_, i) => i !== index);
    pendingFocus.current = rest[Math.max(0, index - 1)]?.rowId ?? "";
    onRows(rest);
  };

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Languages aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {t("localesTitle")}
        </p>
        <p className={FIELD_HINT_TEXT}>{t("localesHint", { max: MAX_LOCALE_VARIANTS })}</p>
      </div>

      {/* 켜는 순간 들리도록 polite 영역 안에서 나타난다 — 무음 푸시 안내와 같은 방식 */}
      <div role="status" aria-live="polite">
        {errors.withVariants && (
          <p className="rounded-lg bg-error/10 p-2.5 text-xs font-semibold text-error">{t("errLocalesWithVariants")}</p>
        )}
      </div>

      {rows.map((r, i) => {
        const legendId = `${groupId}-${r.rowId}-legend`;
        const key = errors.rows[r.rowId];
        const message = key ? t(key) : null;
        return (
          <div key={r.rowId} role="group" aria-labelledby={legendId} className="space-y-4 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p id={legendId} className="text-xs font-semibold text-foreground">
                {r.tag.trim() ? t("localeLegendNamed", { tag: r.tag.trim() }) : t("localeLegend", { index: i + 1 })}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={r.tag.trim() ? t("localeRemoveNamed", { tag: r.tag.trim() }) : t("localeRemove", { index: i + 1 })}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </div>
            {/* 오류는 틀린 칸에만 — 태그가 맞는데 본문이 비었으면 본문 칸이 빨개져야 한다 */}
            <Field
              label={t("localeTag")}
              hint={t("localeTagHint", { key: LOCALE_DEFAULT_KEY })}
              error={key === "errLocaleTag" || key === "errLocaleDup" ? message : null}
            >
              <Input
                ref={(el) => {
                  if (el) tagInputRefs.current.set(r.rowId, el);
                  else tagInputRefs.current.delete(r.rowId);
                }}
                className="font-mono sm:w-48"
                spellCheck={false}
                autoComplete="off"
                maxLength={35}
                value={r.tag}
                disabled={disabled}
                onChange={(e) => setRow(r.rowId, { tag: e.target.value })}
                placeholder="ko-KR"
              />
            </Field>
            <Field label={t("localeTitle")} error={key === "errLocaleText" && !r.title.trim() ? message : null}>
              <Input
                maxLength={TITLE_MAX}
                value={r.title}
                disabled={disabled}
                onChange={(e) => setRow(r.rowId, { title: e.target.value })}
                placeholder={t("titlePlaceholder")}
              />
            </Field>
            <Field label={t("localeBody")} error={key === "errLocaleText" && !r.body.trim() ? message : null}>
              <Textarea
                className="min-h-20"
                maxLength={BODY_MAX}
                value={r.body}
                disabled={disabled}
                onChange={(e) => setRow(r.rowId, { body: e.target.value })}
                placeholder={t("bodyPlaceholder")}
              />
            </Field>
          </div>
        );
      })}

      {rows.length < MAX_LOCALE_VARIANTS && (
        <Button ref={addRef} type="button" variant="outline" disabled={disabled || hasVariants} onClick={add}>
          <Plus aria-hidden="true" className="size-4" /> {t("localeAdd")}
        </Button>
      )}
    </div>
  );
}
