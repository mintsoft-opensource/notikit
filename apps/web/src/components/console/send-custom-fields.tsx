"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";
import type { TemplateField } from "@/lib/templates";
import type { MessageTemplate } from "./template-form";

export type ExtraField = { key: string; value: string };

/**
 * 템플릿 고르기. 목록을 받아 오면 initialId(링크로 넘어온 템플릿)를 한 번 적용한다.
 * 적용 여부(덮어쓰기 확인)는 호출측이 정한다 — false 를 돌려주면 선택을 되돌린다.
 */
export function SendTemplatePicker({
  projectId,
  initialId,
  onApply,
}: {
  projectId: string;
  initialId?: string;
  onApply: (tpl: MessageTemplate | null, opts: { initial: boolean }) => boolean;
}) {
  const t = useTranslations("send");
  const [items, setItems] = React.useState<MessageTemplate[] | null>(null);
  const [selected, setSelected] = React.useState("");
  const appliedInitial = React.useRef(false);
  const onApplyRef = React.useRef(onApply);
  onApplyRef.current = onApply;

  React.useEffect(() => {
    let alive = true;
    adminApi<{ templates: MessageTemplate[] }>(`/api/admin/projects/${projectId}/templates`)
      .then((d) => {
        if (!alive) return;
        setItems(d.templates);
        const initial = initialId ? d.templates.find((x) => x.id === initialId) : undefined;
        if (initial && !appliedInitial.current) {
          appliedInitial.current = true;
          if (onApplyRef.current(initial, { initial: true })) setSelected(initial.id);
        }
      })
      .catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [projectId, initialId]);

  function change(id: string) {
    const tpl = items?.find((x) => x.id === id) ?? null;
    if (onApply(tpl, { initial: false })) setSelected(id);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <Field label={t("template")}>
          <Select value={selected} onChange={(e) => change(e.target.value)} disabled={!items}>
            <option value="">{t("noTemplate")}</option>
            {items?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      </div>
      <Link href={`/projects/${projectId}/templates`} className="pb-2 text-xs font-semibold text-primary hover:underline">
        {t("manageTemplates")}
      </Link>
    </div>
  );
}

/** 커스텀 필드(푸시 data) 입력 — 템플릿이 정한 필드 + 이번 발송에만 쓰는 자유 필드 */
export function SendCustomFields({
  fields,
  values,
  onValues,
  extras,
  onExtras,
}: {
  fields: TemplateField[];
  values: Record<string, string>;
  onValues: (v: Record<string, string>) => void;
  extras: ExtraField[];
  onExtras: (e: ExtraField[]) => void;
}) {
  const t = useTranslations("send");
  const setExtra = (i: number, patch: Partial<ExtraField>) => onExtras(extras.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <Field key={f.key} label={`${f.label || f.key}${f.required ? " *" : ""}`} hint={f.label ? f.key : undefined}>
              <Input
                spellCheck={false}
                value={values[f.key] ?? ""}
                onChange={(e) => onValues({ ...values, [f.key]: e.target.value })}
                placeholder={f.default ?? ""}
              />
            </Field>
          ))}
        </div>
      )}

      {extras.map((x, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-2">
          <Input aria-label={t("extraKey")} className="font-mono" spellCheck={false} value={x.key} onChange={(e) => setExtra(i, { key: e.target.value })} placeholder="key" />
          <Input aria-label={t("extraValue")} spellCheck={false} value={x.value} onChange={(e) => setExtra(i, { value: e.target.value })} placeholder="value" />
          <Button type="button" variant="ghost" size="icon" aria-label={t("removeExtra")} onClick={() => onExtras(extras.filter((_, j) => j !== i))}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => onExtras([...extras, { key: "", value: "" }])}>
          <Plus aria-hidden="true" className="h-4 w-4" /> {t("addExtra")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("customFieldsHint")}</span>
      </div>
    </div>
  );
}
