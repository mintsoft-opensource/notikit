"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Clock, Hourglass, Layers, Play, RefreshCw, Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { formatDuration } from "@/components/console/panels";
import { useProjects, adminApi } from "@/lib/admin-client";

type QueueItem = {
  id: string;
  title: string;
  type: string;
  target: string | null;
  status: string;
  totalCount: number;
  scheduledAt: string | null;
  lockedAt: string | null;
  createdAt: string;
};

type QueueRes = {
  summary: { queued: number; processing: number; scheduled: number; oldestQueuedSec: number | null };
  items: QueueItem[];
  truncated: boolean;
};

const statusVariant = (s: string) =>
  s === "processing" ? "primary" : s === "scheduled" ? "neutral" : "warning";

/** 발송 큐 — 아직 나가지 않은 건과 대기 시간. 워커 정지·예약 적체가 여기서 드러난다. */
export function QueueConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("queue");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;

  const [data, setData] = React.useState<QueueRes | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // 응답 순서가 뒤집혀 옛 프로젝트 결과가 남는 것을 막는다
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id) return;
      const my = ++reqRef.current;
      setLoading(true);
      try {
        const d = await adminApi<QueueRes>(`/api/admin/projects/${id}/queue`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setData(d);
      } catch (e) {
        if (my === reqRef.current) toast.error(e instanceof Error ? e.message : t("loadFailed"));
      } finally {
        if (my === reqRef.current) setLoading(false);
      }
    },
    [t]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
    else setData(null);
  }, [sel, load]);

  async function processQueue() {
    if (!sel || busy) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
      await load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  const df = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const num = (v: number | undefined) => (v === undefined ? "—" : nf.format(v));

  const s = data?.summary;
  const busyLoad = !data && loading;

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sel && load(sel)} disabled={!sel || loading}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> {tc("refresh")}
            </Button>
            <Button size="sm" onClick={processQueue} disabled={!sel || busy}>
              <Play aria-hidden="true" className="h-4 w-4" /> {t("processQueue")}
            </Button>
          </>
        }
      />

      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      {!sel ? (
        <Card className="rounded-none">
          <CardContent className="p-0">
            <EmptyState icon={Layers} title={tc("selectProjectFirst")} />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile loading={busyLoad} icon={Hourglass} label={t("statQueued")} value={num(s?.queued)} />
            <StatTile loading={busyLoad} icon={Timer} label={t("statProcessing")} value={num(s?.processing)} />
            <StatTile loading={busyLoad} icon={Clock} label={t("statScheduled")} value={num(s?.scheduled)} />
            <StatTile
              loading={busyLoad}
              icon={Hourglass}
              label={t("statOldest")}
              value={s?.oldestQueuedSec ? formatDuration(s.oldestQueuedSec) : "—"}
              hint={s?.queued ? t("staleHint") : null}
              accent={s?.oldestQueuedSec && s.oldestQueuedSec > 600 ? "danger" : "default"}
            />
          </div>

          <Card className="rounded-none">
            <CardContent className="p-0">
              {busyLoad && (
                <div className="space-y-3 p-3.5">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              )}
              {data && data.items.length === 0 && <EmptyState icon={Layers} title={t("empty")} />}
              {data && data.items.length > 0 && (
                <DataTable label={t("title")} rowCount={data.items.length + 1}>
                  <TableHeader
                    grid="xl:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_6rem_10rem_7rem]"
                    columns={[
                      { label: t("colTitle") },
                      { label: t("colType") },
                      { label: t("colTarget") },
                      { label: t("colAudience"), align: "end" },
                      { label: t("colWhen"), align: "end" },
                      { label: t("colStatus"), align: "end" },
                    ]}
                  />
                  <TableBody>
                    {data.items.map((it) => {
                      // 예약은 "언제 나갈지", 나머지는 "얼마나 기다렸는지"가 궁금한 값이다
                      const due = it.scheduledAt
                        ? (new Date(it.scheduledAt).getTime() - Date.now()) / 1000
                        : (Date.now() - new Date(it.createdAt).getTime()) / 1000;
                      return (
                        <TableRow
                          key={it.id}
                          className="grid min-h-14 gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_6rem_10rem_7rem] xl:items-center"
                        >
                          <TableCell label={t("colTitle")} className="truncate text-sm font-semibold">{it.title}</TableCell>
                          <TableCell label={t("colType")} className="text-xs text-muted-foreground">{it.type}</TableCell>
                          <TableCell label={t("colTarget")} className="truncate font-mono text-xs text-muted-foreground">{it.target ?? "—"}</TableCell>
                          <TableCell label={t("colAudience")} className="text-xs tabular-nums text-muted-foreground xl:text-right">
                            {nf.format(it.totalCount)}
                          </TableCell>
                          <TableCell label={t("colWhen")} className="text-xs tabular-nums text-muted-foreground xl:text-right">
                            {it.scheduledAt ? (
                              <span title={df.format(new Date(it.scheduledAt))}>
                                {due > 0 ? t("scheduledFor", { d: formatDuration(due) }) : df.format(new Date(it.scheduledAt))}
                              </span>
                            ) : (
                              t("waitingFor", { d: formatDuration(Math.max(0, due)) })
                            )}
                          </TableCell>
                          <TableCell label={t("colStatus")} className="xl:justify-self-end">
                            <Badge variant={statusVariant(it.status)}>{it.status}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  {data.truncated && (
                    <p className="border-t border-border px-3.5 py-2 text-xs text-muted-foreground">{t("truncated")}</p>
                  )}
                </DataTable>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
