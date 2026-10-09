"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, ArrowRight, Send, Percent, Inbox, Smartphone, Activity, MousePointerClick, PackageMinus, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatTile, EmptyState, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { ChartEmpty } from "@/components/ui/chart-empty";
import { StatTileGrid, type StatDelta } from "@/components/ui/stat-tile";
import { StatusChip } from "@/components/console/log-status";
import { pctChange, ptChange, ratio } from "@/lib/stat-delta";
import { useProjects, adminApi } from "@/lib/admin-client";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";
import { FIELD_HINT_TEXT } from "@/components/ui/input";
import { useNumberFormat } from "@/lib/number-format";

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
  /** 클릭에 귀속된 전환 — 없으면(구버전 응답) 타일을 비워 둔다 */
  conversions?: { count: number; value_cents: number };
  /** 직전 같은 길이 구간 — 없으면(구버전 응답) 증감을 표시하지 않는다 */
  previous?: { sends: number; recipients: number; success: number; conversions?: number };
};

type RangeKey = "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["24h", "7d", "30d"];

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

  const nf = useNumberFormat();
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
  const deltaLabel = t("deltaVsPrevious");
  const prev = stats?.previous;
  const toDelta = (value: number | null, unit: StatDelta["unit"]): StatDelta | null =>
    value === null ? null : { value, unit, label: deltaLabel };
  const sendsDelta = stats && prev ? toDelta(pctChange(stats.messages.sends, prev.sends), "%") : null;
  const successDelta =
    stats && prev
      ? toDelta(ptChange(ratio(stats.messages.success, stats.messages.recipients), ratio(prev.success, prev.recipients)), "pt")
      : null;
  const conversionsDelta =
    stats && prev && typeof prev.conversions === "number" && stats.conversions
      ? toDelta(pctChange(stats.conversions.count, prev.conversions), "%")
      : null;

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
                <Send aria-hidden="true" className="size-4" /> {t("linkSend")}
              </Link>
            </Button>
          </div>
        }
      />

      {project && (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-2xs font-semibold text-muted-foreground">api-key</p>
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate font-mono text-sm">{project.apiKey}</p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={async () => { try { await navigator.clipboard.writeText(project.apiKey); toast.success(t("apiKeyCopied")); } catch { toast.error(tc("copyFailed")); } }}
              >
                <Copy aria-hidden="true" /> {tc("copy")}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project.hasFirebase ? <Badge variant="success">{t("firebaseConfigured")}</Badge> : <Badge variant="neutral">{tc("logOnly")}</Badge>}
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <Eyebrow>{rangeLabel}</Eyebrow>
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
            className={cn("rounded-sm font-semibold text-primary hover:underline", FOCUS_RING)}
          >
            {tc("retry")}
          </button>
        </div>
      )}

      <StatTileGrid>
        <StatTile icon={Send} label={t("statSends")} value={num(stats?.messages.sends)} loading={busy} delta={sendsDelta} />
        <StatTile icon={Percent} label={t("successRate")} value={successRate} accent="success" loading={busy} delta={successDelta} />
        <StatTile
          icon={Target}
          label={t("statConversions")}
          value={num(stats?.conversions?.count)}
          loading={busy}
          delta={conversionsDelta}
          hint={stats?.conversions ? t("statConversionValue", { value: nf.format(stats.conversions.value_cents) }) : null}
        />
        <StatTile icon={Inbox} label={ts("statQueued")} value={num(stats?.messages.queued)} loading={busy} />
        <StatTile
          icon={Smartphone}
          label={t("statDevices")}
          value={num(stats?.devices.total)}
          loading={busy}
          hint={stats ? `${t("statActiveDevices")} ${nf.format(stats.devices.active)}` : null}
        />
      </StatTileGrid>

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
            <ChartEmpty icon={Send} title={ts("empty")} className="h-44" />
          )
        ) : (
          <ChartEmpty icon={Send} title={statsError ? t("statsLoadFailed") : tc("loading")} className="h-44" />
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
                    <p className={FIELD_HINT_TEXT}>
                      {l.type} · {df.format(new Date(l.createdAt))}
                    </p>
                  </div>
                  <div className="grid grid-cols-[3rem_6rem] items-center gap-3 text-end">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {l.successCount}/{l.totalCount}
                    </span>
                    {/* 목록 화면과 같은 칩을 쓴다 — 개요에만 번역 안 된 원문 상태를 띄우면 같은 값이 두 가지로 보인다 */}
                    <StatusChip status={l.status} />
                  </div>
                </li>
              ))}
            </ul>
            <Link
              href={`/projects/${projectId}/logs`}
              className={cn("mt-3 inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-primary hover:underline", FOCUS_RING)}
            >
              {t("viewAll")} <ArrowRight aria-hidden="true" className="size-4" />
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
          <Button key={path} variant="outline" asChild>
            <Link href={`/projects/${projectId}/${path}`}>
              <Icon aria-hidden="true" /> {label} <ArrowRight aria-hidden="true" className="text-muted-foreground" />
            </Link>
          </Button>
        ))}
      </nav>
    </div>
  );
}
