"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, ArrowRight, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatStrip, Panel, EmptyNote, BarList } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { useProjects, adminApi } from "@/lib/admin-client";

type RecentLog = { id: string; title: string; type: string; status: string; totalCount: number; successCount: number; createdAt: string };

type Stats = {
  devices: { total: number; active: number; dau: number };
  users: { total: number };
  messages: { total_sends: number; total_delivered: number; sends_24h: number; recipients_24h: number; success_24h: number; queued: number };
  hourly: Array<{ ts: string; count: number }>;
  statuses: Record<string, number>;
  recent: RecentLog[];
};

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--success)",
  failed: "var(--error)",
  processing: "var(--primary)",
  scheduled: "var(--warning)",
  queued: "var(--gy400)",
};

function statusVariant(s: string): "success" | "danger" | "neutral" | "primary" {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "scheduled") return "primary";
  return "neutral";
}

export function ProjectOverview({ projectId }: { projectId: string }) {
  const t = useTranslations("overview");
  const ts = useTranslations("system");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [statsError, setStatsError] = React.useState(false);
  const [statsRetry, setStatsRetry] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setStats(null);
    setStatsError(false);
    adminApi<Stats>(`/api/admin/projects/${projectId}/stats`)
      .then((d) => alive && setStats(d))
      .catch(() => alive && setStatsError(true));
    return () => {
      alive = false;
    };
  }, [projectId, statsRetry]);

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hf = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale]);
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : statsError ? "—" : "…");
  const successRate =
    stats && stats.messages.recipients_24h > 0
      ? `${((stats.messages.success_24h / stats.messages.recipients_24h) * 100).toFixed(1)}%`
      : stats || statsError
        ? "—"
        : "…";

  return (
    <div className="w-full space-y-5">
      <PageHeader
        title={project?.name ?? t("projectFallback")}
        description={t("subtitle")}
        actions={project ? <Badge variant={project.environment === "production" ? "primary" : "neutral"}>{project.environment}</Badge> : undefined}
      />

      {project && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">api-key</p>
              <p className="truncate font-mono text-sm">{project.apiKey}</p>
            </div>
            <button
              type="button"
              onClick={async () => { try { await navigator.clipboard.writeText(project.apiKey); toast.success(t("apiKeyCopied")); } catch { toast.error(tc("copyFailed")); } }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Copy aria-hidden="true" className="h-3.5 w-3.5" /> {tc("copy")}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {project.hasFirebase ? <Badge variant="success">{t("firebaseConfigured")}</Badge> : <Badge variant="neutral">log-only</Badge>}
            {project.hasKakao && <Badge variant="success">{t("kakaoConfigured")}</Badge>}
            <Link
              href={`/projects/${projectId}/settings`}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Settings aria-hidden="true" className="h-3.5 w-3.5" /> {t("linkSettings")}
            </Link>
          </div>
        </div>
      )}

      {statsError && (
        <div role="status" aria-live="polite" className="flex items-center justify-between rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-muted-foreground">
          <span>{t("statsLoadFailed")}</span>
          <button
            type="button"
            onClick={() => setStatsRetry((n) => n + 1)}
            className="rounded-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {tc("retry")}
          </button>
        </div>
      )}

      <StatStrip
        cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
        cells={[
          { key: "sends", label: t("sends24h"), value: num(stats?.messages.sends_24h), spark: stats?.hourly.map((h) => h.count) },
          { key: "rate", label: t("successRate24h"), value: successRate },
          { key: "queued", label: ts("statQueued"), value: num(stats?.messages.queued) },
          { key: "devices", label: t("statDevices"), value: num(stats?.devices.total), hint: stats ? `${t("statActiveDevices")} ${nf.format(stats.devices.active)}` : null },
          { key: "dau", label: t("dau"), value: num(stats?.devices.dau) },
          { key: "users", label: t("statUsers"), value: num(stats?.users.total) },
        ]}
      />

      <Panel title={ts("chartHourly")} sub={ts("range24h")}>
        {stats ? (
          stats.hourly.some((h) => h.count > 0) ? (
            <LiveChart
              times={stats.hourly.map((h) => new Date(h.ts).getTime())}
              area
              height={180}
              formatY={(v) => nf.format(Math.round(v))}
              formatTime={(ms) => hf.format(ms)}
              series={[{ key: "sends", label: t("sends24h"), color: "var(--chart-1)", values: stats.hourly.map((h) => h.count) }]}
            />
          ) : (
            <EmptyNote>{ts("empty")}</EmptyNote>
          )
        ) : (
          <EmptyNote>{statsError ? "—" : tc("loading")}</EmptyNote>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
        <Panel className="h-full" title={ts("chartStatuses")} sub={ts("range24h")}>
          {stats && Object.keys(stats.statuses).length > 0 ? (
            <BarList
              rows={Object.entries(stats.statuses)
                .sort((a, b) => b[1] - a[1])
                .map(([s, v]) => ({ label: s, value: v, color: STATUS_COLOR[s] ?? "var(--gy400)" }))}
            />
          ) : (
            <EmptyNote>{stats ? ts("empty") : statsError ? "—" : tc("loading")}</EmptyNote>
          )}
        </Panel>

        <Panel className="h-full" title={t("recentTitle")}>
          {stats && stats.recent.length > 0 ? (
            <div>
              <ul className="divide-y divide-border">
                {stats.recent.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{l.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {l.type} · {df.format(new Date(l.createdAt))}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {l.successCount}/{l.totalCount}
                      </span>
                      <Badge variant={statusVariant(l.status)}>{l.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
              <Link
                href={`/projects/${projectId}/logs`}
                className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {t("viewAll")} <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : (
            <EmptyNote>{stats ? ts("empty") : statsError ? "—" : tc("loading")}</EmptyNote>
          )}
        </Panel>
      </div>
    </div>
  );
}
