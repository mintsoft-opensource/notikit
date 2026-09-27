"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Field, Input, Textarea } from "@/components/ui/input";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { newRowId } from "@/lib/row-id";
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

/** 편집 중인 필드 행 — rowId 는 화면 key 용이고 저장할 때 빠진다 */
type FieldDraft = TemplateField & { rowId: string };

type Draft = { name: string; title: string; body: string; deepLink: string; fields: FieldDraft[] };

const EMPTY: Draft = { name: "", title: "", body: "", deepLink: "", fields: [] };

function toDraft(t: MessageTemplate | null): Draft {
  if (!t) return EMPTY;
  const fields = t.fields.map((f) => ({ ...f, rowId: newRowId() }));
  return { name: t.name, title: t.title, body: t.body, deepLink: t.deepLink ?? "", fields };
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
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setDraft(toDraft(editing));
  }, [open, editing]);

  const renamed = Boolean(editing && draft.name.trim() && draft.name.trim() !== editing.name);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setField = (rowId: string, patch: Partial<TemplateField>) =>
    set("fields", draft.fields.map((f) => (f.rowId === rowId ? { ...f, ...patch } : f)));

  // 저장 중에는 닫지 않는다 — 닫고 다른 템플릿을 열면 늦게 끝난 저장이 그 화면을 새로고침·토스트로 흔든다
  function requestClose() {
    if (busy) return;
    onClose();
  }

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
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      size="lg"
      title={editing ? t("editTitle") : t("newTitle")}
      description={t("formHint")}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose} disabled={busy}>{tc("cancel")}</Button>
          <Button onClick={save} disabled={busy || !draft.name.trim()}>{busy ? tc("loading") : tc("save")}</Button>
        </>
      }
    >
      {/* 저장 중 편집을 막는다 — fieldset disabled 가 안의 입력·버튼을 한꺼번에 잠근다 */}
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <Field label={t("name")} hint={renamed ? undefined : t("nameHint")}>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={120} placeholder={t("namePlaceholder")} />
        </Field>
        {/* API 는 이름으로 템플릿을 찾는다 — 바꾸면 옛 이름으로 부르는 서버가 조용히 404 를 받는다 */}
        {renamed && (
          <p role="alert" className="-mt-2 rounded-tile border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            {t("renameWarning", { name: editing!.name })}
          </p>
        )}
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
          <p className={FIELD_HINT_TEXT}>{t("fieldsHint")}</p>
          {draft.fields.length > 0 && (
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 text-2xs font-semibold text-muted-foreground sm:grid">
              <span>{t("fieldKey")}</span>
              <span>{t("fieldLabel")}</span>
              <span>{t("fieldDefault")}</span>
              <span>{t("fieldRequired")}</span>
              <span className="w-8" />
            </div>
          )}
          {draft.fields.map((f) => (
            <div key={f.rowId} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
              <Input aria-label={t("fieldKey")} className="font-mono" spellCheck={false} value={f.key} onChange={(e) => setField(f.rowId, { key: e.target.value })} placeholder="order_id" />
              <Input aria-label={t("fieldLabel")} value={f.label ?? ""} onChange={(e) => setField(f.rowId, { label: e.target.value })} placeholder={t("fieldLabelPlaceholder")} />
              <Input aria-label={t("fieldDefault")} value={f.default ?? ""} onChange={(e) => setField(f.rowId, { default: e.target.value })} />
              {/* 체크박스 자체는 16px — 라벨을 36px 칸으로 키워 누를 수 있는 면적을 24px 이상으로 */}
              <label className="flex h-9 min-w-9 cursor-pointer items-center justify-center gap-1.5 text-xs">
                <input type="checkbox" className="size-4 accent-primary" checked={Boolean(f.required)} onChange={(e) => setField(f.rowId, { required: e.target.checked })} />
                <span className="sm:sr-only">{t("fieldRequired")}</span>
              </label>
              <Button type="button" variant="ghost" size="icon" aria-label={t("removeField")} onClick={() => set("fields", draft.fields.filter((x) => x.rowId !== f.rowId))}>
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => set("fields", [...draft.fields, { key: "", rowId: newRowId() }])}>
            <Plus aria-hidden="true" className="size-4" /> {t("addField")}
          </Button>
        </fieldset>
      </fieldset>
    </Dialog>
  );
}
