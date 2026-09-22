"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, ArrowRight, Send, Percent, Inbox, Smartphone, Activity, MousePointerClick, PackageMinus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatTile, EmptyState, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { useProjects, adminApi } from "@/lib/admin-client";

type RecentLog = { id: string; title: string; type: string; status: string; totalCount: number; successCount: number; createdAt: string };

type Stats = {
  range: string;
  devices: { total: number; active: number; dau: number };
  users: { total: number };
  messages: { total_sends: number; total_delivered: number; sends: number; recipients: number; success: number; queued: number };
  buckets: Array<{ ts: string; count: number }>;
  statuses: Record<string, number>;
  platforms: Record<string, number>;
  recent: RecentLog[];
  clicks: {
    clicks: number; click_users: number;
    audience_devices: number; audience_users: number;
    /** 분모가 0이면 null — 0% 로 위장하지 않는다 */
    device_rate: number | null; user_rate: number | null;
    buckets: Array<{ ts: string; count: number }>;
  };
  devices_lifecycle: {
    uninstalled: number; reinstalled: number; net: number;
    buckets: Array<{ ts: string; count: number }>;
  };
};

type RangeKey = "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["24h", "7d", "30d"];

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
  const tn = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rangeParam = searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "24h";
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [statsError, setStatsError] = React.useState(false);
  const [statsRetry, setStatsRetry] = React.useState(0);

  // 요청 시퀀스 가드 — range 를 빠르게 바꿀 때 늦게 도착한 옛 응답이 최신 응답을 덮어쓰지 않도록
  const reqRef = React.useRef(0);

  React.useEffect(() => {
    const my = ++reqRef.current;
    setStats(null);
    setStatsError(false);
    adminApi<Stats>(`/api/admin/projects/${projectId}/stats?range=${range}`)
      .then((d) => my === reqRef.current && setStats(d))
      .catch(() => my === reqRef.current && setStatsError(true));
  }, [projectId, range, statsRetry]);

  function setRange(r: RangeKey) {
    const q = new URLSearchParams(searchParams.toString());
    if (r === "24h") q.delete("range");
    else q.set("range", r);
    router.replace(`/projects/${projectId}${q.size ? `?${q}` : ""}`, { scroll: false });
  }

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const bucketFmt = React.useMemo(
    () =>
      range === "24h"
        ? new Intl.DateTimeFormat(locale, { hour: "numeric" })
        : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale, range]
  );
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");
  const busy = !stats && !statsError;
  const rangeLabelOf = React.useCallback(
    (r: RangeKey) => (r === "24h" ? ts("range24h") : r === "7d" ? ts("range7d") : ts("range30d")),
    [ts]
  );
  const rangeLabel = rangeLabelOf(range);
  const successRate =
    stats && stats.messages.recipients > 0
      ? `${((stats.messages.success / stats.messages.recipients) * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={project?.name ?? t("projectFallback")}
        description={t("subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {project && <Badge variant={project.environment === "production" ? "primary" : "neutral"}>{project.environment}</Badge>}
            <Button size="sm" asChild>
              <Link href={`/projects/${projectId}/send/single`}>
                <Send aria-hidden="true" className="h-4 w-4" /> {t("linkSend")}
              </Link>
            </Button>
          </div>
        }
      />

      {project && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-3.5 py-2.5 shadow-sm shadow-foreground/[0.02]">
          <div className="min-w-0">
            <p className="text-2xs font-semibold text-muted-foreground">api-key</p>
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate font-mono text-sm">{project.apiKey}</p>
              <button
                type="button"
                onClick={async () => { try { await navigator.clipboard.writeText(project.apiKey); toast.success(t("apiKeyCopied")); } catch { toast.error(tc("copyFailed")); } }}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" /> {tc("copy")}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project.hasFirebase ? <Badge variant="success">{t("firebaseConfigured")}</Badge> : <Badge variant="neutral">log-only</Badge>}
            {project.hasKakao && <Badge variant="success">{t("kakaoConfigured")}</Badge>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{rangeLabel}</p>
        <Segmented
          label={rangeLabel}
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((r) => ({ value: r, label: r, srLabel: rangeLabelOf(r) }))}
        />
      </div>

      {statsError && (
        <div role="status" aria-live="polite" className="flex items-center justify-between rounded-tile border border-border bg-surface-muted px-4 py-2.5 text-sm text-muted-foreground">
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile icon={Send} label={t("statSends")} value={num(stats?.messages.sends)} loading={busy} />
        <StatTile icon={Percent} label={t("successRate")} value={successRate} accent="success" loading={busy} />
        <StatTile icon={Inbox} label={ts("statQueued")} value={num(stats?.messages.queued)} loading={busy} />
        <StatTile
          icon={Smartphone}
          label={t("statDevices")}
          value={num(stats?.devices.total)}
          loading={busy}
          hint={stats ? `${t("statActiveDevices")} ${nf.format(stats.devices.active)}` : null}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{ts("chartHourly")}</CardTitle>
            <CardDescription>{rangeLabel}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
        {stats ? (
          stats.buckets.some((h) => h.count > 0) ? (
            <LiveChart
              label={ts("chartHourly")}
              integerY
              times={stats.buckets.map((h) => new Date(h.ts).getTime())}
              area
              height={180}
              formatY={(v) => nf.format(Math.round(v))}
              formatTime={(ms) => bucketFmt.format(ms)}
              series={[{ key: "sends", label: t("statSends"), color: "var(--chart-1)", values: stats.buckets.map((h) => h.count) }]}
            />
          ) : (
            <EmptyState icon={Send} title={ts("empty")} />
          )
        ) : (
          <EmptyState icon={Send} title={statsError ? t("statsLoadFailed") : tc("loading")} />
        )}
      </CardContent>
        </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("recentTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
        {stats && stats.recent.length > 0 ? (
          <div>
            <ul className="divide-y divide-border">
              {stats.recent.map((l) => (
                <li key={l.id} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.type} · {df.format(new Date(l.createdAt))}
                    </p>
                  </div>
                  <div className="grid grid-cols-[3rem_6rem] items-center gap-3 text-right">
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
          <EmptyState icon={Activity} title={stats ? ts("empty") : statsError ? t("statsLoadFailed") : tc("loading")} />
        )}
      </CardContent>
      </Card>

      <nav aria-label={tn("stats")} className="flex flex-wrap gap-2">
        {([
          ["engagement", tn("statsEngagement"), MousePointerClick],
          ["activity", tn("statsActivity"), Activity],
          ["installs", tn("statsInstalls"), PackageMinus],
        ] as const).map(([path, label, Icon]) => (
          <Link
            key={path}
            href={`/projects/${projectId}/${path}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" /> {label} <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
