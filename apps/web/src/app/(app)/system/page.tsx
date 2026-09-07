"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/console/shared";
import { adminApi } from "@/lib/admin-client";

type SystemStats = {
  totals: { sends24h: number; recipients24h: number; success24h: number; queued: number; activeDevices: number; users: number };
  hourly: Array<{ ts: string; count: number; recipients: number; success: number }>;
  statuses: Record<string, number>;
  topProjects: Array<{ id: string; name: string; count: number }>;
  webhooks24h: { delivered: number; failed: number; pending: number };
};

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--success)",
  failed: "var(--error)",
  processing: "var(--primary)",
  scheduled: "var(--warning)",
  queued: "var(--gy400)",
};

/** 시간별 발송 라인 차트 — 단일 시리즈, 크로스헤어 툴팁 */
function HourlyChart({ data, locale }: { data: SystemStats["hourly"]; locale: string }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const W = 720, H = 200, L = 36, R = 10, T = 10, B = 24;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...data.map((d) => d.count));
  const x = (i: number) => L + (data.length <= 1 ? 0 : (i / (data.length - 1)) * iw);
  const y = (v: number) => T + ih - (v / max) * ih;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join("");
  const area = `${line}L${x(data.length - 1).toFixed(1)},${T + ih}L${L},${T + ih}Z`;
  const hf = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale]);
  const tf = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || data.length === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - L) / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  if (data.length === 0) return null;
  const ticks = [0, Math.round(max / 2), max];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={L} x2={W - R} y1={y(tv)} y2={y(tv)} stroke="var(--border)" strokeWidth="1" />
            <text x={L - 6} y={y(tv) + 3} textAnchor="end" fontSize="10" fill="var(--muted-foreground)" className="tabular-nums">
              {nf.format(tv)}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          i % 6 === 0 ? (
            <text key={d.ts} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">
              {hf.format(new Date(d.ts))}
            </text>
          ) : null
        )}
        <path d={area} fill="var(--primary)" opacity="0.12" />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} stroke="var(--border-strong)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(data[hover].count)} r="5" fill="var(--primary)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute -top-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > data.length / 2 ? "-105%" : "8px"})` }}
        >
          <p className="text-muted-foreground">{tf.format(new Date(data[hover].ts))}</p>
          <p className="font-bold tabular-nums">{nf.format(data[hover].count)}</p>
        </div>
      )}
    </div>
  );
}

/** 수평 바 목록 — 단일 색상, 값 라벨 병기 */
function BarList({ rows, color }: { rows: Array<{ label: string; value: number; color?: string }>; color: string }) {
  const nf = new Intl.NumberFormat();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{r.label}</span>
          <span className="h-4 flex-1 overflow-hidden rounded-sm bg-surface-muted">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? color, minWidth: r.value > 0 ? "3px" : 0 }}
            />
          </span>
          <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums">{nf.format(r.value)}</span>
        </div>
      ))}
    </div>
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
  const tf = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

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
      : stats
        ? "—"
        : error
          ? "—"
          : "…";

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard label={t("statSends")} value={num(stats?.totals.sends24h)} />
        <StatCard label={t("statRecipients")} value={num(stats?.totals.recipients24h)} />
        <StatCard label={t("statSuccessRate")} value={successRate} />
        <StatCard label={t("statQueued")} value={num(stats?.totals.queued)} />
        <StatCard label={t("statActiveDevices")} value={num(stats?.totals.activeDevices)} />
        <StatCard label={t("statUsers")} value={num(stats?.totals.users)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("chartHourly")}</CardTitle>
          <CardDescription>{t("range24h")}</CardDescription>
        </CardHeader>
        <CardContent>
          {stats ? (
            stats.hourly.some((h) => h.count > 0) ? (
              <>
                <HourlyChart data={stats.hourly} locale={locale} />
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
                        <td>{tf.format(new Date(h.ts))}</td>
                        <td>{h.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
            )
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">{error ? "—" : tc("loading")}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("chartStatuses")}</CardTitle>
            <CardDescription>{t("range24h")}</CardDescription>
          </CardHeader>
          <CardContent>
            {stats && Object.keys(stats.statuses).length > 0 ? (
              <BarList
                color="var(--primary)"
                rows={Object.entries(stats.statuses)
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, v]) => ({ label: s, value: v, color: STATUS_COLOR[s] ?? "var(--gy400)" }))}
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">{stats ? t("empty") : error ? "—" : tc("loading")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("topProjects")}</CardTitle>
            <CardDescription>{t("range24h")}</CardDescription>
          </CardHeader>
          <CardContent>
            {stats && stats.topProjects.length > 0 ? (
              <BarList color="var(--primary)" rows={stats.topProjects.map((p) => ({ label: p.name, value: p.count }))} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">{stats ? t("empty") : error ? "—" : tc("loading")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("webhooks")}</CardTitle>
          <CardDescription>{t("range24h")}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          {(
            [
              ["whDelivered", stats?.webhooks24h.delivered, "var(--success)"],
              ["whFailed", stats?.webhooks24h.failed, "var(--error)"],
              ["whPending", stats?.webhooks24h.pending, "var(--gy400)"],
            ] as const
          ).map(([key, value, color]) => (
            <div key={key} className="flex items-center gap-2.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
              <div>
                <p className="text-xs text-muted-foreground">{t(key)}</p>
                <p className="text-lg font-extrabold tabular-nums">{num(value)}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
