"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { MousePointerClick, Percent, Send, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
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

type RangeKey = "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["24h", "7d", "30d"];

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
  const [failed, setFailed] = React.useState(false);
  const reqRef = React.useRef(0);

  React.useEffect(() => {
    const my = ++reqRef.current;
    setStats(null);
    setLogs(null);
    setFailed(false);
    Promise.all([
      adminApi<Stats>(`/api/admin/projects/${projectId}/stats?range=${range}`),
      adminApi<{ logs: Log[] }>(`/api/admin/projects/${projectId}/logs`),
    ])
      .then(([s, l]) => {
        if (my !== reqRef.current) return;
        setStats(s);
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
