"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { MAX_IMPORT_ROWS, SUPPRESSION_REASONS } from "@/lib/suppression-import";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type ImportResult = { added: number; skipped: number };

/**
 * 억제 목록 CSV 가져오기 — 다른 도구에서 내보낸 수신 거부 명단을 한 번에 옮긴다.
 * 파일은 브라우저에서 읽어 JSON 으로 보낸다(기본 사유를 함께 보내기 위해).
 */
export function SuppressionsImport({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();
  const errorText = useAdminErrorText();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [reason, setReason] = React.useState<string>("manual");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [inputKey, setInputKey] = React.useState(0);

  function reset() {
    setFile(null);
    setReason("manual");
    setResult(null);
    setInputKey((k) => k + 1);
  }

  function close() {
    if (busy) return;
    setOpen(false);
    reset();
  }

  async function submit() {
    if (!file || busy) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error(t("importTooLarge"));
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const csv = await file.text();
      const d = await adminApi<ImportResult>(`/api/admin/projects/${projectId}/audience/suppressions/import`, {
        method: "POST",
        body: JSON.stringify({ csv, reason }),
      });
      setResult(d);
      toast.success(t("importDone", { added: d.added, skipped: d.skipped }));
      onImported();
    } catch (e) {
      toast.error(errorText(e, t("importFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload aria-hidden="true" className="h-4 w-4" /> {t("importCsv")}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={t("importCsv")}
        description={t("importHint", { max: new Intl.NumberFormat(locale).format(MAX_IMPORT_ROWS) })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>{result ? tc("close") : tc("cancel")}</Button>
            <Button onClick={submit} disabled={!file || busy}>
              <Upload aria-hidden="true" className="h-4 w-4" /> {busy ? tc("loading") : t("importSubmit")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t("importFile")} hint={t("importFormat")}>
            <Input
              key={inputKey}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
              }}
              disabled={busy}
            />
          </Field>
          <Field label={t("importDefaultReason")}>
            <Select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}>
              {SUPPRESSION_REASONS.map((r) => (
                <option key={r} value={r}>{t(`reason_${r}` as "reason_manual")}</option>
              ))}
            </Select>
          </Field>
          {result && (
            <p role="status" className="rounded-lg border border-border bg-surface-muted/40 p-3 text-sm">
              {t("importDone", { added: result.added, skipped: result.skipped })}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
