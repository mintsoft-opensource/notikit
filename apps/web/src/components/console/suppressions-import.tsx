"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Undo2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FIELD_HINT_TEXT, Field, Input, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { MAX_IMPORT_ROWS, SUPPRESSION_REASONS } from "@/lib/suppression-import";
import { numberFormat, useNumberFormat } from "@/lib/number-format";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type ImportResult = { added: number; skipped: number };

/** 되돌리기 버튼이 가리킬 배치 한 건 — 서버가 감사 로그에서 만들어 준다 */
type ImportBatch = {
  batch_id: string;
  added: number;
  skipped: number;
  actor: string;
  created_at: string;
  reverted: boolean;
};

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
        <Upload aria-hidden="true" className="size-4" /> {t("importCsv")}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={t("importCsv")}
        description={t("importHint", { max: numberFormat(locale).format(MAX_IMPORT_ROWS) })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>{result ? tc("close") : tc("cancel")}</Button>
            <Button onClick={submit} disabled={!file || busy}>
              <Upload aria-hidden="true" className="size-4" /> {busy ? tc("loading") : t("importSubmit")}
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

/**
 * 최근 가져오기 배치 + 되돌리기.
 *
 * 되돌리기 경로(`…/import/revert`)는 있었지만 화면이 없어서 잘못된 CSV 하나를 푸는 데
 * curl 이 필요했다 — 5,000명이 차단된 상태에서 터미널을 여는 시간이 그대로 피해다.
 *
 * 되돌린 배치도 목록에서 지우지 않는다. 사라지면 "되돌렸다"와 "그런 배치가 없다"가
 * 구분되지 않아 운영자가 같은 파일을 다시 올린다.
 */
export function SuppressionsImportBatches({
  projectId,
  refreshKey,
  onReverted,
}: {
  projectId: string;
  /** 가져오기가 끝날 때마다 올라간다 — 목록을 다시 읽는 신호 */
  refreshKey: number;
  onReverted: () => void;
}) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();
  const nf = useNumberFormat();
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const errorText = useAdminErrorText();

  const [rows, setRows] = React.useState<ImportBatch[] | null>(null);
  const [target, setTarget] = React.useState<ImportBatch | null>(null);
  const [busy, setBusy] = React.useState(false);
  const reqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const my = ++reqRef.current;
    try {
      const d = await adminApi<{ batches: ImportBatch[] }>(
        `/api/admin/projects/${projectId}/audience/suppressions/import`
      );
      if (my === reqRef.current) setRows(d.batches);
    } catch {
      // 목록을 못 읽는 것으로 억제 화면 전체를 막지 않는다 — 빈 목록으로 접어 둔다
      if (my === reqRef.current) setRows([]);
    }
  }, [projectId]);

  React.useEffect(() => {
    load();
    return () => { reqRef.current++; };
  }, [load, refreshKey]);

  async function revert() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const d = await adminApi<{ removed: number }>(
        `/api/admin/projects/${projectId}/audience/suppressions/import/revert`,
        { method: "POST", body: JSON.stringify({ batch_id: target.batch_id }) }
      );
      toast.success(t("importRevertDone", { removed: d.removed }));
      setTarget(null);
      await load();
      onReverted();
    } catch (e) {
      toast.error(errorText(e, t("importRevertFailed")));
    } finally {
      setBusy(false);
    }
  }

  // 배치가 한 번도 없으면 카드 자체를 내지 않는다 — 빈 카드는 자리만 먹고 알려 주는 게 없다
  if (rows !== null && rows.length === 0) return null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("importBatchesTitle")}</CardTitle>
          <p className={FIELD_HINT_TEXT}>{t("importBatchesHint")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {rows === null && <Skeleton className="h-9 w-full" />}
          {rows?.map((b) => (
            <div key={b.batch_id} className="flex flex-wrap items-center gap-4 border-b border-border pb-4 last:border-0 last:pb-0">
              <span className="text-sm tabular-nums">{df.format(new Date(b.created_at))}</span>
              <span className="text-sm text-muted-foreground">
                {t("importBatchRows", { added: nf.format(b.added), skipped: nf.format(b.skipped) })}
              </span>
              <span className="truncate text-xs text-muted-foreground">{b.actor}</span>
              {b.reverted ? (
                <Badge variant="neutral" className="ms-auto">{t("importBatchReverted")}</Badge>
              ) : (
                <Button variant="outline" className="ms-auto" onClick={() => setTarget(b)} disabled={busy}>
                  <Undo2 aria-hidden="true" className="size-4" /> {t("importRevert")}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 수천 명의 억제가 한 번에 풀린다 — 되돌릴 수 없으므로 창 뒤에 둔다 */}
      <Dialog
        open={target !== null}
        onClose={() => { if (!busy) setTarget(null); }}
        title={t("importRevertTitle")}
        description={t("importRevertConfirm", { added: nf.format(target?.added ?? 0) })}
        initialFocus="dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={busy}>{tc("cancel")}</Button>
            <Button variant="destructive" onClick={revert} disabled={busy}>
              <Undo2 aria-hidden="true" className="size-4" /> {busy ? tc("loading") : t("importRevert")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("importRevertKeepsExisting")}</p>
      </Dialog>
    </>
  );
}
