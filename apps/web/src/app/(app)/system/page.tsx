"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { LiveChart, formatBytes } from "@/components/system/live-chart";
import { adminApi } from "@/lib/admin-client";

type SystemStats = {
  totals: { sends24h: number; recipients24h: number; success24h: number; queued: number; activeDevices: number; users: number };
  hourly: Array<{ ts: string; count: number; recipients: number; success: number }>;
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

function formatDuration(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

/** 섹션 타이틀 — 라벨 + 구분선 (그라파나 row) */
function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2 className="shrink-0 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{children}</h2>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {right}
    </div>
  );
}

/** 셀 배경 스파크라인 — 축 없는 미니 추이 */
function Spark({ values, max }: { values: Array<number | null>; max?: number }) {
  const solid = values.filter((v): v is number => v != null);
  if (solid.length < 2) return null;
  const yMax = max ?? Math.max(1e-9, ...solid) * 1.1;
  const W = 100, H = 100;
  const pts = values
    .map((v, i) => (v == null ? null : `${((i / (values.length - 1)) * W).toFixed(1)},${(H - (Math.min(v, yMax) / yMax) * H).toFixed(1)}`))
    .filter(Boolean) as string[];
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-9 w-full opacity-[0.18]">
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="var(--chart-1)" />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--chart-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type StatCell = { key: string; label: string; value: React.ReactNode; hint?: string | null; spark?: Array<number | null>; sparkMax?: number };

/** 스탯 스트립 — 하나의 카드 안에 헤어라인으로 분할된 셀들 (개별 카드 남발 방지) */
function StatStrip({ cells, cols }: { cells: StatCell[]; cols: string }) {
  return (
    <Card className="overflow-hidden">
      <div className={`grid gap-px bg-border ${cols}`}>
        {cells.map((c) => (
          <div key={c.key} className="relative bg-surface px-4 pb-3 pt-3.5">
            {c.spark && <Spark values={c.spark} max={c.sparkMax} />}
            <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={c.label}>
              {c.label}
            </p>
            <p className="relative mt-1 truncate text-xl font-extrabold leading-tight tracking-tight tabular-nums">{c.value}</p>
            <p className={`relative mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground ${c.hint ? "" : "invisible"}`}>{c.hint || "·"}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 차트 패널 */
function Panel({ title, sub, children, className }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <p className="text-sm font-bold">{title}</p>
          {sub && <p className="shrink-0 text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-9 text-center text-sm text-muted-foreground">{children}</p>;
}

/** 수평 바 목록 */
function BarList({ rows }: { rows: Array<{ label: string; value: number; color?: string }> }) {
  const nf = new Intl.NumberFormat();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-4 flex-1 overflow-hidden rounded-sm bg-surface-muted">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--chart-1)", minWidth: r.value > 0 ? "3px" : 0 }}
            />
          </span>
          <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">{nf.format(r.value)}</span>
        </div>
      ))}
    </div>
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
    <section className="space-y-3">
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

      <StatStrip
        cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
        cells={[
          {
            key: "cpu",
            label: t("cpu"),
            value: val(h ? (h.cpu.usagePct != null ? `${nf.format(h.cpu.usagePct)}%` : "—") : null),
            hint: h ? `${h.cpu.cores} cores · load ${nf.format(h.cpu.loadavg[0])}` : null,
            spark: points.map((p) => p.cpu),
            sparkMax: 100,
          },
          {
            key: "mem",
            label: t("memory"),
            value: val(h ? `${nf.format((h.memory.usedBytes / h.memory.totalBytes) * 100)}%` : null),
            hint: h ? `${formatBytes(h.memory.usedBytes)} / ${formatBytes(h.memory.totalBytes)}` : null,
            spark: points.map((p) => p.memPct),
            sparkMax: 100,
          },
          { key: "rss", label: "RSS", value: val(h ? formatBytes(h.memory.processRssBytes) : null), hint: h ? `heap ${formatBytes(h.memory.heapUsedBytes)}` : null },
          {
            key: "loop",
            label: t("eventLoop"),
            value: val(h ? (h.eventLoop ? `${nf.format(h.eventLoop.p99Ms)} ms` : "—") : null),
            hint: h?.eventLoop ? `p50 ${nf.format(h.eventLoop.p50Ms)} ms` : null,
          },
          { key: "db", label: t("dbLatency"), value: val(latest ? `${nf.format(latest.db.latencyMs)} ms` : null) },
          { key: "up", label: t("uptime"), value: val(h ? formatDuration(h.processUptimeSec) : null), hint: h ? `host ${formatDuration(h.uptimeSec)}` : null },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={t("chartCpu")} sub={t("window5m")}>
          {points.length > 1 ? (
            <LiveChart
              times={times}
              maxY={100}
              area
              height={170}
              formatY={(v) => `${Math.round(v)}%`}
              formatTime={fmtTime}
              series={[{ key: "cpu", label: "CPU", color: "var(--chart-1)", values: points.map((p) => p.cpu) }]}
            />
          ) : (
            <EmptyNote>{t("collecting")}</EmptyNote>
          )}
        </Panel>
        <Panel title={t("chartMemory")} sub={t("window5m")}>
          {points.length > 1 ? (
            <LiveChart
              times={times}
              maxY={100}
              area
              height={170}
              formatY={(v) => `${Math.round(v)}%`}
              formatTime={fmtTime}
              series={[{ key: "mem", label: t("memory"), color: "var(--chart-1)", values: points.map((p) => p.memPct) }]}
            />
          ) : (
            <EmptyNote>{t("collecting")}</EmptyNote>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <Panel title={t("chartNetwork")} sub={t("window5m")}>
          {points.length > 1 && points.some((p) => p.rx != null) ? (
            <LiveChart
              times={times}
              height={170}
              formatY={(v) => `${formatBytes(v)}/s`}
              formatTime={fmtTime}
              series={[
                { key: "rx", label: t("rx"), color: "var(--chart-1)", values: points.map((p) => p.rx) },
                { key: "tx", label: t("tx"), color: "var(--chart-2)", values: points.map((p) => p.tx) },
              ]}
            />
          ) : (
            <EmptyNote>{points.length > 1 ? t("netUnavailable") : t("collecting")}</EmptyNote>
          )}
        </Panel>
        <Panel className="h-full" title={t("queueTitle")}>
          <dl className="space-y-3">
            {(
              [
                [t("queueQueued"), q ? String(q.queued) : null],
                [t("queueProcessing"), q ? String(q.processing) : null],
                [t("queueScheduled"), q ? String(q.scheduled) : null],
                [t("oldestQueued"), q ? (q.oldestQueuedSec != null ? formatDuration(q.oldestQueuedSec) : "—") : null],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="flex items-baseline justify-between gap-2 border-b border-border pb-2.5 last:border-b-0 last:pb-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-base font-extrabold tabular-nums">{val(v)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
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
    <div className="w-full space-y-5">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <HostSection />

      <section className="space-y-3">
        <SectionTitle>{t("delivery")}</SectionTitle>

        {error && (
          <div role="status" aria-live="polite" className="flex items-center justify-between rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-muted-foreground">
            <span>{tc("loadFailed")}</span>
            <button
              type="button"
              onClick={() => setRetryN((n) => n + 1)}
              className="rounded-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {tc("retry")}
            </button>
          </div>
        )}

        <StatStrip
          cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
          cells={[
            {
              key: "sends",
              label: t("statSends"),
              value: num(stats?.totals.sends24h),
              spark: stats?.hourly.map((h) => h.count),
            },
            { key: "recipients", label: t("statRecipients"), value: num(stats?.totals.recipients24h) },
            { key: "rate", label: t("statSuccessRate"), value: successRate },
            { key: "devices", label: t("statActiveDevices"), value: num(stats?.totals.activeDevices) },
            { key: "users", label: t("statUsers"), value: num(stats?.totals.users) },
          ]}
        />

        <Panel title={t("chartHourly")} sub={t("range24h")}>
          {stats ? (
            stats.hourly.some((h) => h.count > 0) ? (
              <>
                <LiveChart
                  times={stats.hourly.map((h) => new Date(h.ts).getTime())}
                  area
                  height={190}
                  formatY={(v) => nf.format(Math.round(v))}
                  formatTime={(ms) => hf.format(ms)}
                  series={[{ key: "sends", label: t("statSends"), color: "var(--chart-1)", values: stats.hourly.map((h) => h.count) }]}
                />
                <table className="sr-only">
                  <caption>{t("chartHourly")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("range24h")}</th>
                      <th scope="col">{t("statSends")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.hourly.map((h) => (
                      <tr key={h.ts}>
                        <td>{new Date(h.ts).toISOString()}</td>
                        <td>{h.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <EmptyNote>{t("empty")}</EmptyNote>
            )
          ) : (
            <EmptyNote>{error ? "—" : tc("loading")}</EmptyNote>
          )}
        </Panel>

        <div className="grid gap-3 lg:grid-cols-3">
          <Panel className="h-full" title={t("chartStatuses")} sub={t("range24h")}>
            {stats && Object.keys(stats.statuses).length > 0 ? (
              <BarList
                rows={Object.entries(stats.statuses)
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, v]) => ({ label: s, value: v, color: STATUS_COLOR[s] ?? "var(--gy400)" }))}
              />
            ) : (
              <EmptyNote>{stats ? t("empty") : error ? "—" : tc("loading")}</EmptyNote>
            )}
          </Panel>

          <Panel className="h-full" title={t("topProjects")} sub={t("range24h")}>
            {stats && stats.topProjects.length > 0 ? (
              <BarList rows={stats.topProjects.map((p) => ({ label: p.name, value: p.count }))} />
            ) : (
              <EmptyNote>{stats ? t("empty") : error ? "—" : tc("loading")}</EmptyNote>
            )}
          </Panel>

          <Panel className="h-full" title={t("webhooks")} sub={t("range24h")}>
            <dl className="space-y-3">
              {(
                [
                  ["whDelivered", stats?.webhooks24h.delivered, "var(--success)"],
                  ["whFailed", stats?.webhooks24h.failed, "var(--error)"],
                  ["whPending", stats?.webhooks24h.pending, "var(--gy400)"],
                ] as const
              ).map(([key, value, color]) => (
                <div key={key} className="flex items-baseline justify-between gap-2 border-b border-border pb-2.5 last:border-b-0 last:pb-0">
                  <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: color }} />
                    {t(key)}
                  </dt>
                  <dd className="text-base font-extrabold tabular-nums">{num(value)}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </section>
    </div>
  );
}
