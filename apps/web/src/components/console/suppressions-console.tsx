"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BellOff, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi } from "@/lib/admin-client";

type Suppression = {
  id: string;
  externalId: string | null;
  token: string | null;
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

  React.useEffect(() => { void load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !externalId.trim()) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/suppressions`, {
        method: "POST",
        body: JSON.stringify({ external_id: externalId.trim(), reason }),
      });
      toast.success(t("suppressionAdded"));
      setExternalId("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc("loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Suppression) {
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/suppressions?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      toast.success(t("suppressionRemoved"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("suppressionsTitle")} description={t("suppressionsSubtitle")} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("addSuppression")}</CardTitle>
            <CardDescription>{t("addSuppressionHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="grid items-end gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,12rem)_auto]">
            <Field label="external_id">
              <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="user-1" maxLength={255} spellCheck={false} />
            </Field>
            <Field label={t("reason")}>
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <option key={r} value={r}>{t(`reason_${r}` as "reason_manual")}</option>)}
              </Select>
            </Field>
            <Button type="submit" size="sm" className="justify-self-start" disabled={busy || !externalId.trim()}>
              <Plus aria-hidden="true" className="h-4 w-4" /> {busy ? tc("loading") : t("addSuppression")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {!rows && <div className="space-y-3 p-5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {rows && rows.length === 0 && <EmptyState icon={BellOff} title={t("noSuppressions")} />}
          {rows && rows.length > 0 && (
            <ul className="divide-y divide-border">
              {rows.map((s) => (
                <li key={s.id} className="grid gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[minmax(0,1fr)_8rem_10rem_auto] sm:items-center">
                  <p className="truncate font-mono text-sm font-semibold">
                    {s.externalId ?? `${s.token?.slice(0, 8)}…`}
                  </p>
                  <Badge variant={reasonVariant(s.reason)}>{t(`reason_${s.reason}` as "reason_manual")}</Badge>
                  <time dateTime={s.createdAt} className="text-xs tabular-nums text-muted-foreground">
                    {df.format(new Date(s.createdAt))}
                  </time>
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-self-end"
                    aria-label={`${t("suppressionRemove")} ${s.externalId ?? ""}`}
                    onClick={() => remove(s)}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
