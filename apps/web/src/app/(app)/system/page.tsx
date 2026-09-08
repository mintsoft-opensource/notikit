"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Cpu, MemoryStick, HardDrive, Timer, Database, Clock, Send, Users, Smartphone, Percent, Inbox, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, EmptyState, DataRow, SectionTitle, BarList, formatDuration } from "@/components/console/panels";
import { LiveChart, formatBytes } from "@/components/system/live-chart";
import { adminApi } from "@/lib/admin-client";

type SystemStats = {
  totals: { sends24h: number; recipients24h: number; success24h: number; queued: number; activeDevices: number; users: number };
  hourly: Array<{ ts: string; count: number }>;
  statuses: Record<string, number>;
  topProjects: Array<{ id: string; name: string; count: number }>;
  webhooks24h: { delivered: number; failed: number; pending: number };
};

type HostStats = {
  host: {
    cpu: { usagePct: number | null; loadavg: [number, number, number]; cores: number };
    memory: { totalBytes: number; usedBytes: number; processRssBytes: number; heapUsedBytes: number };
    network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
    eventLoop: { p50Ms: number; p99Ms: number } | null;
    uptimeSec: number;
    processUptimeSec: number;
    platform: string;
  };
  db: { latencyMs: number };
  queue: { queued: number; processing: number; scheduled: number; oldestQueuedSec: number | null };
  at: string;
};

type HostPoint = { t: number; cpu: number | null; memPct: number; rx: number | null; tx: number | null };

const POLL_MS = 5000;
const WINDOW = 60; // 5분 (60 × 5s)

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--success)",
  failed: "var(--error)",
  processing: "var(--primary)",
  scheduled: "var(--warning)",
  queued: "var(--gy400)",
};

/** 카드 헤더 — 제목 + 부제 (goji CardHeader 는 flex 라 좌측 블록으로 감싼다) */
function PanelHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <CardHeader>
      <div>
        <CardTitle>{title}</CardTitle>
        {sub && <CardDescription>{sub}</CardDescription>}
      </div>
    </CardHeader>
  );
}

/** 호스트 실시간 섹션 — 5초 폴링, 5분 롤링 윈도우 */
function HostSection() {
  const t = useTranslations("system");
  const locale = useLocale();
  const [latest, setLatest] = React.useState<HostStats | null>(null);
  const [points, setPoints] = React.useState<HostPoint[]>([]);
  const [error, setError] = React.useState(false);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const tfm = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }), [locale]);

  React.useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const d = await adminApi<HostStats>("/api/admin/system/host");
        if (!alive) return;
        setError(false);
        setLatest(d);
        setPoints((prev) =>
          [
            ...prev,
            {
              t: new Date(d.at).getTime(),
              cpu: d.host.cpu.usagePct,
              memPct: (d.host.memory.usedBytes / d.host.memory.totalBytes) * 100,
              rx: d.host.network?.rxBytesPerSec ?? null,
              tx: d.host.network?.txBytesPerSec ?? null,
            },
          ].slice(-WINDOW)
        );
      } catch {
        if (alive) setError(true);
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const h = latest?.host;
  const q = latest?.queue;
  const val = (s: string | null | undefined) => s ?? (error ? "—" : "…");
  const times = points.map((p) => p.t);
  const fmtTime = (ms: number) => tfm.format(ms);

  return (
    <section className="space-y-4">
      <SectionTitle
        right={
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${error ? "bg-error" : "bg-success"}`} />
            {error ? t("hostUnreachable") : t("autoRefresh")}
          </span>
        }
      >
        {t("host")}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatTile
          icon={Cpu}
          label={t("cpu")}
          value={val(h ? (h.cpu.usagePct != null ? `${nf.format(h.cpu.usagePct)}%` : "—") : null)}
          hint={h ? `${h.cpu.cores} cores · load ${nf.format(h.cpu.loadavg[0])}` : null}
        />
        <StatTile
          icon={MemoryStick}
          label={t("memory")}
          value={val(h ? `${nf.format((h.memory.usedBytes / h.memory.totalBytes) * 100)}%` : null)}
          hint={h ? `${formatBytes(h.memory.usedBytes, locale)} / ${formatBytes(h.memory.totalBytes, locale)}` : null}
        />
        <StatTile
          icon={HardDrive}
          label="RSS"
          value={val(h ? formatBytes(h.memory.processRssBytes, locale) : null)}
          hint={h ? `heap ${formatBytes(h.memory.heapUsedBytes, locale)}` : null}
        />
        <StatTile
          icon={Timer}
          label={t("eventLoop")}
          value={val(h ? (h.eventLoop ? `${nf.format(h.eventLoop.p99Ms)} ms` : "—") : null)}
          hint={h?.eventLoop ? `p50 ${nf.format(h.eventLoop.p50Ms)} ms` : null}
        />
        <StatTile icon={Database} label={t("dbLatency")} value={val(latest ? `${nf.format(latest.db.latencyMs)} ms` : null)} />
        <StatTile
          icon={Clock}
          label={t("uptime")}
          value={val(h ? formatDuration(h.processUptimeSec) : null)}
          hint={h ? `host ${formatDuration(h.uptimeSec)}` : null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <PanelHead title={t("chartCpu")} sub={t("window5m")} />
          <CardContent>
            {points.length > 1 ? (
              <LiveChart
                label={t("chartCpu")}
                times={times}
                maxY={100}
                area
                height={170}
                formatY={(v) => `${Math.round(v)}%`}
                formatTime={fmtTime}
                series={[{ key: "cpu", label: "CPU", color: "var(--chart-1)", values: points.map((p) => p.cpu) }]}
              />
            ) : (
              <EmptyState icon={Activity} title={t("collecting")} />
            )}
          </CardContent>
        </Card>
        <Card>
          <PanelHead title={t("chartMemory")} sub={t("window5m")} />
          <CardContent>
            {points.length > 1 ? (
              <LiveChart
                label={t("chartMemory")}
                times={times}
                maxY={100}
                area
                height={170}
                formatY={(v) => `${Math.round(v)}%`}
                formatTime={fmtTime}
                series={[{ key: "mem", label: t("memory"), color: "var(--chart-1)", values: points.map((p) => p.memPct) }]}
              />
            ) : (
              <EmptyState icon={Activity} title={t("collecting")} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <PanelHead title={t("chartNetwork")} sub={t("window5m")} />
          <CardContent>
            {points.length > 1 && points.some((p) => p.rx != null) ? (
              <LiveChart
                label={t("chartNetwork")}
                times={times}
                height={170}
                formatY={(v) => `${formatBytes(v, locale)}/s`}
                formatTime={fmtTime}
                series={[
                  { key: "rx", label: t("rx"), color: "var(--chart-1)", values: points.map((p) => p.rx) },
                  { key: "tx", label: t("tx"), color: "var(--chart-2)", values: points.map((p) => p.tx) },
                ]}
              />
            ) : (
              <EmptyState icon={Activity} title={points.length > 1 ? t("netUnavailable") : t("collecting")} />
            )}
          </CardContent>
        </Card>
        <Card>
          <PanelHead title={t("queueTitle")} />
          <CardContent>
            <dl className="space-y-3">
              <DataRow label={t("queueQueued")} value={val(q ? String(q.queued) : null)} />
              <DataRow label={t("queueProcessing")} value={val(q ? String(q.processing) : null)} />
              <DataRow label={t("queueScheduled")} value={val(q ? String(q.scheduled) : null)} />
              <DataRow
                label={t("oldestQueued")}
                value={val(q ? (q.oldestQueuedSec != null ? formatDuration(q.oldestQueuedSec) : "—") : null)}
                tone={q?.oldestQueuedSec != null && q.oldestQueuedSec > 300 ? "warning" : "default"}
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default function SystemPage() {
  const t = useTranslations("system");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [stats, setStats] = React.useState<SystemStats | null>(null);
  const [error, setError] = React.useState(false);
  const [retryN, setRetryN] = React.useState(0);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hf = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale]);

  React.useEffect(() => {
    let alive = true;
    setError(false);
    adminApi<SystemStats>("/api/admin/system/stats")
      .then((d) => alive && setStats(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [retryN]);

  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : error ? "—" : "…");
  const successRate =
    stats && stats.totals.recipients24h > 0
      ? `${((stats.totals.success24h / stats.totals.recipients24h) * 100).toFixed(1)}%`
      : stats || error
        ? "—"
        : "…";

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <HostSection />

      <section className="space-y-4">
        <SectionTitle>{t("delivery")}</SectionTitle>

        {error && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-between rounded-tile border border-border bg-surface-muted px-4 py-2.5 text-sm text-muted-foreground"
          >
            <span>{tc("loadFailed")}</span>
            <button
              type="button"
              onClick={() => setRetryN((n) => n + 1)}
              className="rounded-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {tc("retry")}
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <StatTile icon={Send} label={t("statSends")} value={num(stats?.totals.sends24h)} />
          <StatTile icon={Inbox} label={t("statRecipients")} value={num(stats?.totals.recipients24h)} />
          <StatTile icon={Percent} label={t("statSuccessRate")} value={successRate} accent="success" />
          <StatTile icon={Smartphone} label={t("statActiveDevices")} value={num(stats?.totals.activeDevices)} />
          <StatTile icon={Users} label={t("statUsers")} value={num(stats?.totals.users)} />
        </div>

        <Card>
          <PanelHead title={t("chartHourly")} sub={t("range24h")} />
          <CardContent>
            {stats ? (
              stats.hourly.some((h) => h.count > 0) ? (
                <LiveChart
                  label={t("chartHourly")}
                  integerY
                  times={stats.hourly.map((h) => new Date(h.ts).getTime())}
                  area
                  height={190}
                  formatY={(v) => nf.format(Math.round(v))}
                  formatTime={(ms) => hf.format(ms)}
                  series={[{ key: "sends", label: t("statSends"), color: "var(--chart-1)", values: stats.hourly.map((h) => h.count) }]}
                />
              ) : (
                <EmptyState icon={Send} title={t("empty")} />
              )
            ) : (
              <EmptyState icon={Send} title={error ? "—" : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <PanelHead title={t("chartStatuses")} sub={t("range24h")} />
            <CardContent>
              {stats && Object.keys(stats.statuses).length > 0 ? (
                <BarList
                  rows={Object.entries(stats.statuses)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, v]) => ({ label: s, value: v, color: STATUS_COLOR[s] ?? "var(--gy400)" }))}
                />
              ) : (
                <EmptyState icon={Activity} title={stats ? t("empty") : error ? "—" : tc("loading")} />
              )}
            </CardContent>
          </Card>

          <Card>
            <PanelHead title={t("topProjects")} sub={t("range24h")} />
            <CardContent>
              {stats && stats.topProjects.length > 0 ? (
                <BarList rows={stats.topProjects.map((p) => ({ label: p.name, value: p.count }))} />
              ) : (
                <EmptyState icon={Send} title={stats ? t("empty") : error ? "—" : tc("loading")} />
              )}
            </CardContent>
          </Card>

          <Card>
            <PanelHead title={t("webhooks")} sub={t("range24h")} />
            <CardContent>
              <dl className="space-y-3">
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--success)" }} />
                      {t("whDelivered")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.delivered)}
                />
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--error)" }} />
                      {t("whFailed")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.failed)}
                  tone={stats && stats.webhooks24h.failed > 0 ? "danger" : "default"}
                />
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--gy400)" }} />
                      {t("whPending")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.pending)}
                />
              </dl>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
