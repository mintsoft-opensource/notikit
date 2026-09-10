"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { MousePointerClick, Percent, Send, Users, CalendarClock, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { Heatmap } from "@/components/system/heatmap";
import { BarList } from "@/components/console/panels";
import { adminApi } from "@/lib/admin-client";

type Stats = {
  clicks: {
    clicks: number;
    click_users: number;
    audience_devices: number;
    audience_users: number;
    /** 분모가 0이면 null — 0% 로 위장하지 않는다 */
    device_rate: number | null;
    user_rate: number | null;
    buckets: Array<{ ts: string; count: number }>;
  };
  messages: { sends: number };
};

type Log = {
  id: string;
  title: string;
  type: string;
  target: string | null;
  clickCount: number;
  clickUserCount: number;
  audienceUserCount: number;
  createdAt: string;
};

type Deep = {
  total: number;
  /** [요일][시간] — 요일 0 = 일요일 */
  heatmap: number[][];
  /** 클릭이 없으면 null — 0시로 위장하지 않는다 */
  peak: { dow: number; hour: number; count: number } | null;
  latency: Record<string, number>;
  latencyAvgSeconds: number | null;
  platforms: Array<{ platform: string; count: number }>;
};

type RangeKey = "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["24h", "7d", "30d"];
/** 심화 통계는 24h 구간이 너무 얕아 최소 7d 로 조회한다 */
const DEEP_RANGE: Record<RangeKey, "7d" | "30d" | "90d"> = { "24h": "7d", "7d": "7d", "30d": "30d" };
const LATENCY_KEYS = ["lt1m", "lt5m", "lt30m", "lt2h", "lt1d", "gte1d"] as const;

/** 참여 통계 — 클릭 퍼널과 발송별 읽음률. 개요의 요약보다 깊게 본다. */
export function EngagementConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("engagementStats");
  const to = useTranslations("overview");
  const ts = useTranslations("system");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [range, setRange] = React.useState<RangeKey>("7d");
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [logs, setLogs] = React.useState<Log[] | null>(null);
  const [deep, setDeep] = React.useState<Deep | null>(null);
  const [failed, setFailed] = React.useState(false);
  const reqRef = React.useRef(0);

  React.useEffect(() => {
    const my = ++reqRef.current;
    setStats(null);
    setLogs(null);
    setDeep(null);
    setFailed(false);
    Promise.all([
      adminApi<Stats>(`/api/admin/projects/${projectId}/stats?range=${range}`),
      adminApi<{ logs: Log[] }>(`/api/admin/projects/${projectId}/logs`),
      adminApi<Deep>(`/api/admin/projects/${projectId}/engagement?range=${DEEP_RANGE[range]}`),
    ])
      .then(([s, l, d]) => {
        if (my !== reqRef.current) return;
        setStats(s);
        setDeep(d);
        // 읽음률 높은 순 — 대상이 0인 발송은 비율이 정의되지 않으므로 뒤로 민다
        setLogs(
          [...l.logs].sort(
            (a, b) =>
              (b.audienceUserCount > 0 ? b.clickUserCount / b.audienceUserCount : -1) -
              (a.audienceUserCount > 0 ? a.clickUserCount / a.audienceUserCount : -1)
          )
        );
      })
      .catch((e) => {
        if (my !== reqRef.current) return;
        setFailed(true);
        toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      });
  }, [projectId, range, tc]);

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const bucketFmt = React.useMemo(
    () =>
      range === "24h"
        ? new Intl.DateTimeFormat(locale, { hour: "numeric" })
        : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale, range]
  );
  const busy = !stats && !failed;
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");
  const pct = (v: number | null | undefined) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");
  const rangeLabelOf = (r: RangeKey) => (r === "24h" ? ts("range24h") : r === "7d" ? ts("range7d") : ts("range30d"));

  /** 요일 이름은 로케일에서 뽑는다 — 하드코딩하면 25개 언어에 키가 또 늘어난다 */
  const dayLabels = React.useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    // 2024-01-07 이 일요일 — Postgres extract(dow) 의 0 과 맞춘다
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 7 + i))));
  }, [locale]);

  const humanSeconds = (s: number) => {
    if (s < 60) return t("secondsShort", { n: s });
    if (s < 3600) return t("minutesShort", { n: Math.round(s / 60) });
    if (s < 86400) return t("hoursShort", { n: Math.round(s / 3600) });
    return t("daysShort", { n: Math.round(s / 86400) });
  };

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{rangeLabelOf(range)}</p>
        <Segmented
          label={rangeLabelOf(range)}
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((r) => ({ value: r, label: r, srLabel: rangeLabelOf(r) }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile icon={Send} label={to("statSends")} value={num(stats?.messages.sends)} loading={busy} />
        <StatTile icon={MousePointerClick} label={to("statClicks")} value={num(stats?.clicks.clicks)} loading={busy} />
        <StatTile
          icon={Percent}
          label={to("clickUserRate")}
          value={stats ? pct(stats.clicks.user_rate) : "—"}
          accent="success"
          loading={busy}
          hint={stats ? `${nf.format(stats.clicks.click_users)} / ${nf.format(stats.clicks.audience_users)}` : null}
        />
        <StatTile
          icon={Users}
          label={to("clickDeviceRate")}
          value={stats ? pct(stats.clicks.device_rate) : "—"}
          loading={busy}
          hint={stats ? `${nf.format(stats.clicks.clicks)} / ${nf.format(stats.clicks.audience_devices)}` : null}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{to("chartClicks")}</CardTitle>
            <CardDescription>{rangeLabelOf(range)}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {stats ? (
            stats.clicks.buckets.some((b) => b.count > 0) ? (
              <LiveChart
                label={to("chartClicks")}
                integerY
                area
                height={200}
                times={stats.clicks.buckets.map((b) => new Date(b.ts).getTime())}
                formatY={(v) => nf.format(Math.round(v))}
                formatTime={(ms) => bucketFmt.format(ms)}
                series={[{ key: "clicks", label: to("statClicks"), color: "var(--chart-2)", values: stats.clicks.buckets.map((b) => b.count) }]}
              />
            ) : (
              <EmptyState icon={MousePointerClick} title={to("noClicks")} />
            )
          ) : (
            <EmptyState icon={MousePointerClick} title={failed ? tc("loadFailed") : tc("loading")} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <CalendarClock aria-hidden="true" className="h-4 w-4" /> {t("heatmapTitle")}
              </CardTitle>
              <CardDescription>
                {deep?.peak
                  ? t("peakHint", { day: dayLabels[deep.peak.dow], hour: deep.peak.hour, count: nf.format(deep.peak.count) })
                  : t("heatmapHint")}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {deep ? (
              deep.total > 0 ? (
                <Heatmap
                  label={t("heatmapTitle")}
                  grid={deep.heatmap}
                  dayLabels={dayLabels}
                  formatValue={(v) => nf.format(v)}
                  cellLabel={(day, hour, value) => t("cellLabel", { day, hour, count: nf.format(value) })}
                />
              ) : (
                <EmptyState icon={CalendarClock} title={to("noClicks")} />
              )
            ) : (
              <EmptyState icon={CalendarClock} title={failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4">
          <Card className="min-w-0">
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  <Timer aria-hidden="true" className="h-4 w-4" /> {t("latencyTitle")}
                </CardTitle>
                <CardDescription>
                  {deep?.latencyAvgSeconds !== null && deep?.latencyAvgSeconds !== undefined
                    ? t("latencyAvg", { value: humanSeconds(deep.latencyAvgSeconds) })
                    : t("latencyHint")}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {deep && deep.total > 0 ? (
                <BarList rows={LATENCY_KEYS.map((k) => ({ label: t(`latency_${k}` as "latency_lt1m"), value: deep.latency[k] ?? 0 }))} />
              ) : (
                <EmptyState icon={Timer} title={deep ? to("noClicks") : failed ? tc("loadFailed") : tc("loading")} />
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{t("platformTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {deep && deep.platforms.length > 0 ? (
                <BarList rows={deep.platforms.map((p) => ({ label: p.platform, value: p.count }))} />
              ) : (
                <EmptyState icon={Users} title={deep ? to("noClicks") : failed ? tc("loadFailed") : tc("loading")} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("byMessage")}</CardTitle>
            <CardDescription>{t("byMessageHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {logs && logs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-left">
                <thead className="border-b border-border">
                  <tr className="text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
                    <th scope="col" className="px-5 py-2.5">{t("colMessage")}</th>
                    <th scope="col" className="px-3 py-2.5">{t("colType")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right">{t("colAudience")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right">{t("colReaders")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right">{t("colRate")}</th>
                    <th scope="col" className="px-5 py-2.5 text-right">{t("colSentAt")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {logs.map((l) => (
                    <tr key={l.id} className="transition-colors hover:bg-surface-muted/30">
                      <td className="max-w-0 truncate px-5 py-3 text-sm font-medium">{l.title}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {l.target ? <span className="font-mono">{l.target}</span> : l.type}
                      </td>
                      <td className="px-3 py-3 text-right text-xs tabular-nums text-muted-foreground">{nf.format(l.audienceUserCount)}</td>
                      <td className="px-3 py-3 text-right text-xs tabular-nums text-muted-foreground">{nf.format(l.clickUserCount)}</td>
                      <td className="px-3 py-3 text-right text-xs font-bold tabular-nums">
                        {l.audienceUserCount > 0 ? `${((l.clickUserCount / l.audienceUserCount) * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right text-xs tabular-nums text-muted-foreground">
                        <time dateTime={l.createdAt}>{df.format(new Date(l.createdAt))}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Send} title={logs ? ts("empty") : failed ? tc("loadFailed") : tc("loading")} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
