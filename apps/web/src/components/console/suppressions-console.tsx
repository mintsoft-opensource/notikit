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
import { cursorQuery, type Cursor } from "@/lib/cursor-query";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { SuppressionsImport, SuppressionsImportBatches } from "./suppressions-import";

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
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();

  const [rows, setRows] = React.useState<Suppression[] | null>(null);
  const [externalId, setExternalId] = React.useState("");
  const [reason, setReason] = React.useState("manual");
  const [busy, setBusy] = React.useState(false);
  /** 가져오기가 끝날 때마다 올린다 — 배치 목록이 방금 올린 회차를 바로 보여야 한다 */
  const [imported, setImported] = React.useState(0);

  /** 서버는 쪽 단위로 준다 — 첫 쪽만 보여 주면 그 뒤의 억제는 콘솔에서 조회도 해제도 할 수 없다 */
  const [next, setNext] = React.useState<Cursor>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  /** 다시 불러오면 올린다 — 이전 목록의 "더 보기" 응답을 새 목록에 붙이지 않는다 */
  const genRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const my = ++genRef.current;
    try {
      const d = await adminApi<{ suppressions: Suppression[]; next: Cursor }>(`/api/admin/projects/${projectId}/audience/suppressions`);
      if (my !== genRef.current) return;
      setRows(d.suppressions);
      setNext(d.next);
    } catch (e) {
      if (my !== genRef.current) return;
      setRows([]);
      toast.error(errorText(e, tc("loadFailed")));
    }
  }, [projectId, tc, errorText]);

  async function loadMore() {
    if (!next || loadingMore) return;
    const my = genRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<{ suppressions: Suppression[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/suppressions?${cursorQuery(next)}`
      );
      if (my !== genRef.current) return;
      setRows((cur) => [...(cur ?? []), ...d.suppressions]);
      setNext(d.next);
    } catch (e) {
      if (my === genRef.current) toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === genRef.current) setLoadingMore(false);
    }
  }

  const [open, setOpen] = React.useState(false);
  /**
   * 드래프트(대상·사유)가 바뀔 때마다 올린다. 응답을 기다리는 사이 무엇이든 고쳤다면
   * 완료 시 지우지 않는다 — 대상만 비교하면 사유만 고친 경우를 놓친다.
   */
  const revisionRef = React.useRef(0);
  const editExternalId = (v: string) => { revisionRef.current++; setExternalId(v); };
  const editReason = (v: string) => { revisionRef.current++; setReason(v); };

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
    // 제출 시점의 리비전을 기억한다 — 응답이 늦는 사이 드래프트를 고쳤다면 완료 시 지우지 않는다
    const submitted = revisionRef.current;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/suppressions`, {
        method: "POST",
        body: JSON.stringify({ user_id: externalId.trim(), reason }),
      });
      toast.success(t("suppressionAdded"));
      if (revisionRef.current === submitted) {
        setExternalId("");
        setReason("manual");
        setOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(errorText(err, tc("loadFailed")));
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
      toast.error(errorText(e, tc("loadFailed")));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("suppressionsTitle")}
        description={t("suppressionsSubtitle")}
        actions={
          <>
            <SuppressionsImport projectId={projectId} onImported={() => { setImported((n) => n + 1); void load(); }} />
            <Button onClick={() => setOpen(true)}>
              <Plus aria-hidden="true" className="size-4" /> {t("addSuppression")}
            </Button>
          </>
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
        <form onSubmit={add} className="space-y-4">
          <Field label={t("userIdLabel")}>
            <Input id="new-suppression-id" value={externalId} onChange={(e) => editExternalId(e.target.value)} placeholder="user-1" maxLength={255} spellCheck={false} />
          </Field>
          <Field label={t("reason")}>
            <Select value={reason} onChange={(e) => editReason(e.target.value)}>
              {REASONS.map((r) => <option key={r} value={r}>{t(`reason_${r}` as "reason_manual")}</option>)}
            </Select>
          </Field>
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Dialog>

      {/* 가져오기 사고는 목록보다 먼저 보여야 한다 — 되돌리기를 찾아 스크롤하게 두지 않는다 */}
      <SuppressionsImportBatches
        projectId={projectId}
        refreshKey={imported}
        onReverted={() => void load()}
      />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!rows && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
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
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {next && (
              <div className="flex justify-center border-t border-border p-3">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? tc("loading") : tc("loadMore")}
                </Button>
              </div>
            )}
            </DataTable>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
