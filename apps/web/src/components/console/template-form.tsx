"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Field } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";
import type { TemplateField } from "@/lib/templates";

export type MessageTemplate = {
  id: string;
  name: string;
  title: string;
  body: string;
  deepLink: string | null;
  fields: TemplateField[];
  updatedAt: string;
};

type Draft = { name: string; title: string; body: string; deepLink: string; fields: TemplateField[] };

const EMPTY: Draft = { name: "", title: "", body: "", deepLink: "", fields: [] };

function toDraft(t: MessageTemplate | null): Draft {
  return t ? { name: t.name, title: t.title, body: t.body, deepLink: t.deepLink ?? "", fields: t.fields } : EMPTY;
}

/** 템플릿 생성·수정 팝업. editing 이 null 이면 새로 만든다. */
export function TemplateFormDialog({
  open,
  projectId,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  editing: MessageTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("templates");
  const tc = useTranslations("common");
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setDraft(toDraft(editing));
  }, [open, editing]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setField = (i: number, patch: Partial<TemplateField>) =>
    set("fields", draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  async function save() {
    if (busy || !draft.name.trim()) return;
    // 키를 비워 둔 행은 "아직 안 쓴 줄"로 보고 뺀다 — 저장 실패보다 덜 번거롭다
    const fields = draft.fields
      .filter((f) => f.key.trim())
      .map((f) => ({
        key: f.key.trim(),
        ...(f.label?.trim() ? { label: f.label.trim() } : {}),
        ...(f.default?.trim() ? { default: f.default.trim() } : {}),
        ...(f.required ? { required: true } : {}),
      }));
    const body = { name: draft.name.trim(), title: draft.title, body: draft.body, deep_link: draft.deepLink.trim() || null, fields };

    setBusy(true);
    try {
      await adminApi(editing ? `/api/admin/projects/${projectId}/templates/${editing.id}` : `/api/admin/projects/${projectId}/templates`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      toast.success(t("saved"));
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? t("editTitle") : t("newTitle")}
      description={t("formHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
          <Button onClick={save} disabled={busy || !draft.name.trim()}>{busy ? tc("loading") : tc("save")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("name")}>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={120} placeholder={t("namePlaceholder")} />
        </Field>
        <Field label={t("messageTitle")}>
          <Input value={draft.title} onChange={(e) => set("title", e.target.value)} maxLength={255} />
        </Field>
        <Field label={t("messageBody")}>
          <Textarea className="min-h-24" value={draft.body} onChange={(e) => set("body", e.target.value)} maxLength={4000} />
        </Field>
        <Field label={t("deepLink")}>
          <Input inputMode="url" spellCheck={false} value={draft.deepLink} onChange={(e) => set("deepLink", e.target.value)} placeholder="myapp://path · https://…" />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t("fields")}</legend>
          <p className="text-xs text-muted-foreground">{t("fieldsHint")}</p>
          {draft.fields.length > 0 && (
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 text-2xs font-semibold text-muted-foreground sm:grid">
              <span>{t("fieldKey")}</span>
              <span>{t("fieldLabel")}</span>
              <span>{t("fieldDefault")}</span>
              <span>{t("fieldRequired")}</span>
              <span className="w-8" />
            </div>
          )}
          {draft.fields.map((f, i) => (
            <div key={i} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
              <Input aria-label={t("fieldKey")} className="font-mono" spellCheck={false} value={f.key} onChange={(e) => setField(i, { key: e.target.value })} placeholder="order_id" />
              <Input aria-label={t("fieldLabel")} value={f.label ?? ""} onChange={(e) => setField(i, { label: e.target.value })} placeholder={t("fieldLabelPlaceholder")} />
              <Input aria-label={t("fieldDefault")} value={f.default ?? ""} onChange={(e) => setField(i, { default: e.target.value })} />
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={Boolean(f.required)} onChange={(e) => setField(i, { required: e.target.checked })} />
                <span className="sm:sr-only">{t("fieldRequired")}</span>
              </label>
              <Button type="button" variant="ghost" size="icon" aria-label={t("removeField")} onClick={() => set("fields", draft.fields.filter((_, j) => j !== i))}>
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => set("fields", [...draft.fields, { key: "" }])}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("addField")}
          </Button>
        </fieldset>
      </div>
    </Dialog>
  );
}
