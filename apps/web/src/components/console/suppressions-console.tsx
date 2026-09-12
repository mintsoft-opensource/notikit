"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BellOff, Plus, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog } from "@/components/ui/dialog";
import { adminApi } from "@/lib/admin-client";

type Suppression = {
  id: string;
  externalId: string | null;
  /** 서버가 마스킹한 값 — 원문 토큰은 내려오지 않는다 */
  tokenPreview: string | null;
  reason: string;
  createdAt: string;
};

const REASONS = ["manual", "opt_out", "bounced", "complaint"];

function reasonVariant(r: string): "danger" | "warning" | "neutral" {
  if (r === "complaint") return "danger";
  if (r === "bounced") return "warning";
  return "neutral";
}

/** 억제 목록 — 절대 발송하지 않을 대상. 발송에서 제외되고 클릭률 분모에서도 빠진다. */
export function SuppressionsConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [rows, setRows] = React.useState<Suppression[] | null>(null);
  const [externalId, setExternalId] = React.useState("");
  const [reason, setReason] = React.useState("manual");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ suppressions: Suppression[] }>(`/api/admin/projects/${projectId}/audience/suppressions`);
      setRows(d.suppressions);
    } catch (e) {
      setRows([]);
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }, [projectId, tc]);

  const [open, setOpen] = React.useState(false);
  // 비동기 완료 시점의 최신 입력을 읽기 위한 거울
  const idRef = React.useRef(externalId);
  idRef.current = externalId;

  React.useEffect(() => { void load(); }, [load]);

  function closeDialog() {
    // reason 만 바꾼 것도 입력이다 — 안 물어보고 닫으면 고른 값이 조용히 사라진다
    const dirty = externalId.trim() !== "" || reason !== "manual";
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    setExternalId("");
    setReason("manual");
  }

  async function add(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !externalId.trim()) return;
    // 응답이 늦는 사이 새 드래프트를 치기 시작했다면 완료 시 그걸 지워서는 안 된다
    const submitted = externalId;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/suppressions`, {
        method: "POST",
        body: JSON.stringify({ external_id: externalId.trim(), reason }),
      });
      toast.success(t("suppressionAdded"));
      if (idRef.current === submitted) {
        setExternalId("");
        setReason("manual");
        setOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc("loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Suppression) {
    /**
     * 해제는 "이 사람에게 다시 발송한다"는 뜻이다. opt_out 은 본인이 거부한 것이고
     * 다수 관할에서 법적 의무라, 확인 없이 한 번의 클릭으로 풀려서는 안 된다.
     */
    if (!confirm(t("confirmRemoveSuppression", { target: row.externalId ?? row.tokenPreview ?? row.id }))) return;
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/suppressions/${row.id}`, { method: "DELETE" });
      toast.success(t("suppressionRemoved"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("suppressionsTitle")}
        description={t("suppressionsSubtitle")}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("addSuppression")}
          </Button>
        }
      />

      <Dialog
        open={open}
        onClose={closeDialog}
        title={t("addSuppression")}
        description={t("addSuppressionHint")}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>{tc("cancel")}</Button>
            <Button onClick={() => add()} disabled={busy || !externalId.trim()}>
              {busy ? tc("loading") : t("addSuppression")}
            </Button>
          </>
        }
      >
        <form onSubmit={add} className="space-y-3">
          <Field label="external_id">
            <Input id="new-suppression-id" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="user-1" maxLength={255} spellCheck={false} />
          </Field>
          <Field label={t("reason")}>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r} value={r}>{t(`reason_${r}` as "reason_manual")}</option>)}
            </Select>
          </Field>
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Dialog>

      <Card className="rounded-none">
        <CardContent className="p-0">
          {!rows && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {rows && rows.length === 0 && <EmptyState icon={BellOff} title={t("noSuppressions")} />}
          {rows && rows.length > 0 && (
            <>
            <DataTable label={t("suppressionsTitle")} rowCount={rows.length + 1}>
            <TableHeader
              grid="sm:grid-cols-[minmax(0,1fr)_8rem_10rem_auto]"
              show="sm"
              columns={[
                { label: t("colTarget") },
                { label: t("colReason") },
                { label: t("colRegistered") },
                { label: "", blank: true },
              ]}
            />
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[minmax(0,1fr)_8rem_10rem_auto] sm:items-center">
                  <TableCell label={t("colTarget")} className="truncate font-mono text-sm font-semibold">
                    {s.externalId ?? s.tokenPreview ?? "—"}
                  </TableCell>
                  <TableCell label={t("colReason")}>
                    <Badge variant={reasonVariant(s.reason)}>{t(`reason_${s.reason}` as "reason_manual")}</Badge>
                  </TableCell>
                  <TableCell label={t("colRegistered")} className="text-xs tabular-nums text-muted-foreground">
                    {df.format(new Date(s.createdAt))}
                  </TableCell>
                  <TableCell label={t("suppressionRemove")}>
                  <Button
                    variant="outline"
                    size="icon"
                    className="justify-self-end"
                    aria-label={`${t("suppressionRemove")} ${s.externalId ?? ""}`}
                    onClick={() => remove(s)}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            </DataTable>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
