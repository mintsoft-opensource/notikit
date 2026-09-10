"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Play, ScrollText, ChevronDown, ChevronRight, MousePointerClick } from "lucide-react";
import { LiveChart } from "@/components/system/live-chart";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Log = {
  id: string;
  title: string;
  type: string;
  target: string | null;
  status: string;
  totalCount: number;
  successCount: number;
  audienceUserCount: number;
  audienceDeviceCount: number;
  clickCount: number;
  clickUserCount: number;
  createdAt: string;
};

type Reader = {
  id: string;
  externalId: string | null;
  platform: string | null;
  destination: string | null;
  clickedAt: string;
};

/** 발송 타입 필터 — 없으면 전체 */
export type LogFilter = "single" | "topic" | undefined;

function statusVariant(s: string): "success" | "danger" | "neutral" | "primary" {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "scheduled") return "primary";
  return "neutral";
}

type ReadPoint = { ts: string; count: number; cumulative: number };
type ReadersResponse = { readers: Reader[]; series: ReadPoint[]; bucket: "hour" | "day"; next: string | null };

/**
 * 이 발송을 읽은(알림을 누른) 사람 — 시간순 추이 + 전체 표.
 * 펼칠 때 처음 한 번만 불러온다. 목록 50건의 수신자를 미리 다 받으면 로그 화면이 느려진다.
 */
function ReaderDetail({ projectId, logId }: { projectId: string; logId: string }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [data, setData] = React.useState<ReadersResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [more, setMore] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    adminApi<ReadersResponse>(`/api/admin/projects/${projectId}/logs/${logId}/readers`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [projectId, logId]);

  async function loadMore() {
    if (!data?.next || more) return;
    setMore(true);
    try {
      const d = await adminApi<ReadersResponse>(
        `/api/admin/projects/${projectId}/logs/${logId}/readers?before=${encodeURIComponent(data.next)}`
      );
      setData((cur) => (cur ? { ...cur, readers: [...cur.readers, ...d.readers], next: d.next } : cur));
    } catch {
      /* 다음 시도에서 재요청 */
    } finally {
      setMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const bucketFmt = React.useMemo(
    () =>
      data?.bucket === "day"
        ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
        : new Intl.DateTimeFormat(locale, { hour: "numeric" }),
    [locale, data?.bucket]
  );

  if (failed) return <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">{t("loadFailed")}</p>;
  if (!data) {
    return (
      <div className="space-y-2 border-t border-border px-5 py-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t border-border bg-surface-muted/20 px-5 py-4">
      <section>
        <h4 className="mb-2 text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{t("readTrend")}</h4>
        {data.series.some((p) => p.count > 0) ? (
          <LiveChart
            label={t("readTrend")}
            integerY
            area
            height={140}
            times={data.series.map((p) => new Date(p.ts).getTime())}
            formatY={(v) => nf.format(Math.round(v))}
            formatTime={(ms) => bucketFmt.format(ms)}
            series={[
              { key: "reads", label: t("readsPerBucket"), color: "var(--chart-2)", values: data.series.map((p) => p.count) },
              { key: "cumulative", label: t("readsCumulative"), color: "var(--chart-1)", values: data.series.map((p) => p.cumulative) },
            ]}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("noReaders")}</p>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          {t("readerTable", { count: nf.format(data.readers.length) })}
        </h4>
        {data.readers.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("noReaders")}</p>
        ) : (
          <div className="overflow-x-auto rounded-tile border border-border bg-surface">
            <table className="w-full min-w-[36rem] text-left">
              <thead className="border-b border-border">
                <tr className="text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
                  <th scope="col" className="px-3 py-2">{t("colUser")}</th>
                  <th scope="col" className="px-3 py-2">{t("colPlatform")}</th>
                  <th scope="col" className="px-3 py-2">{t("colDestination")}</th>
                  <th scope="col" className="px-3 py-2 text-right">{t("colReadAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.readers.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-0 truncate px-3 py-2 font-mono text-xs font-semibold">
                      {r.externalId ?? <span className="font-sans font-normal text-muted-foreground">{t("anonymousReader")}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.platform ?? "—"}</td>
                    <td className="max-w-0 truncate px-3 py-2 text-xs text-muted-foreground">{r.destination ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                      <time dateTime={r.clickedAt}>{df.format(new Date(r.clickedAt))}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.next && (
              <div className="flex justify-center border-t border-border p-2">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={more}>
                  {more ? tc("loading") : tc("loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export function LogsConsole({ projectId, filter }: { projectId?: string; filter?: LogFilter }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [logs, setLogs] = React.useState<Log[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return;
      const my = ++reqRef.current;
      setLoading(true);
      setLogs([]);
      setOpen(null);
      try {
        const q = filter ? `?type=${filter}` : "";
        const d = await adminApi<{ logs: Log[] }>(`/api/admin/projects/${id}/logs${q}`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setLogs(d.logs);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : t("loadFailed"));
      } finally {
        if (my === reqRef.current) setLoading(false);
      }
    },
    [t, filter]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
    else setLogs([]);
  }, [sel, load]);

  async function processQueue() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number; failed: number }>(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processResult", { processed: d.processed, failed: d.failed }));
      load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("processFailed"));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  /** 분모가 0이면 비율은 정의되지 않는다 — 0% 는 "아무도 안 읽었다"로 오독된다 */
  const rate = (num: number, den: number) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "—");

  const title = filter === "single" ? t("titleSingle") : filter === "topic" ? t("titleTopic") : t("title");
  const subtitle = filter === "single" ? t("subtitleSingle") : filter === "topic" ? t("subtitleTopic") : t("subtitle");
  // 읽은 사람 목록은 여러 명이 대상인 발송에서만 의미가 있다
  const expandable = filter !== "single";

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title={title}
        description={subtitle}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sel && load(sel)} disabled={!sel}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> {tc("refresh")}
            </Button>
            <Button size="sm" onClick={processQueue} disabled={!sel}>
              <Play aria-hidden="true" className="h-4 w-4" /> {t("processQueue")}
            </Button>
          </>
        }
      />

      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      <Card>
        <CardContent className="p-0">
          {!sel && <EmptyState icon={ScrollText} title={tc("selectProjectFirst")} />}
          {sel && loading && <div className="space-y-3 p-5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {sel && !loading && logs.length === 0 && <EmptyState icon={ScrollText} title={t("empty")} />}
          {logs.length > 0 && (
            <ul className="divide-y divide-border">
              {logs.map((l) => {
                const isOpen = open === l.id;
                return (
                  <li key={l.id}>
                    <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[auto_minmax(0,1fr)_9rem_13rem_5rem_6rem_7rem]">
                      {expandable ? (
                        <button
                          type="button"
                          onClick={() => setOpen(isOpen ? null : l.id)}
                          aria-expanded={isOpen}
                          aria-label={`${t("readers")} — ${l.title}`}
                          className="col-start-1 row-start-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      ) : (
                        <span className="hidden xl:block" />
                      )}
                      <p className="truncate text-sm font-semibold" title={l.title}>{l.title}</p>
                      <span className="truncate text-xs text-muted-foreground">
                        {l.target ? <span className="font-mono">{l.target}</span> : l.type}
                      </span>
                      <time dateTime={l.createdAt} className="text-xs tabular-nums text-muted-foreground xl:text-right">
                        {df.format(new Date(l.createdAt))}
                      </time>
                      <span className="text-right text-xs font-semibold tabular-nums text-muted-foreground">
                        {nf.format(l.successCount)}/{nf.format(l.totalCount)}
                      </span>
                      <span
                        className="flex items-center justify-end gap-1 text-xs font-semibold tabular-nums"
                        title={t("readRateHint", { read: nf.format(l.clickUserCount), audience: nf.format(l.audienceUserCount) })}
                      >
                        <MousePointerClick aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                        {rate(l.clickUserCount, l.audienceUserCount)}
                      </span>
                      <div className="justify-self-end"><Badge variant={statusVariant(l.status)}>{l.status}</Badge></div>
                    </div>
                    {expandable && isOpen && <ReaderDetail projectId={sel} logId={l.id} />}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
