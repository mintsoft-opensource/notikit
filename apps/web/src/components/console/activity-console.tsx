"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Activity, Users, Smartphone, Repeat, LineChart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, BarList, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { adminApi } from "@/lib/admin-client";

type Counts = { devices: number; users: number };
type Stats = {
  range: string;
  dau: Counts;
  wau: Counts;
  mau: Counts;
  /** DAU/MAU — 분모가 0이면 null */
  stickiness: number | null;
  opens: number;
  buckets: Array<{ day: string; devices: number; users: number; opens: number }>;
  platforms: Record<string, number>;
};

type RetentionPoint = { offset: number; retained: number | null; rate: number | null };
type Retention = {
  offsets: number[];
  cohorts: Array<{ day: string; size: number; points: RetentionPoint[] }>;
  summary: Array<{ offset: number; retained: number; base: number; rate: number | null }>;
};

type RangeKey = "7d" | "30d" | "90d";
const RANGE_KEYS: RangeKey[] = ["7d", "30d", "90d"];

/** 접속 통계 — DAU/WAU/MAU 와 일별 추이. 단위는 활성 디바이스(유저는 별도 집계). */
export function ActivityConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("activity");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [range, setRange] = React.useState<RangeKey>("30d");
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [ret, setRet] = React.useState<Retention | null>(null);
  const reqRef = React.useRef(0);

  // 리텐션은 기간 선택과 무관하다 — 코호트 창이 고정이므로 한 번만 받는다
  React.useEffect(() => {
    let alive = true;
    adminApi<Retention>(`/api/admin/projects/${projectId}/retention`)
      .then((d) => alive && setRet(d))
      .catch(() => alive && setRet(null));
    return () => { alive = false; };
  }, [projectId]);

  React.useEffect(() => {
    const my = ++reqRef.current;
    setStats(null);
    setFailed(false);
    adminApi<Stats>(`/api/admin/projects/${projectId}/activity?range=${range}`)
      .then((d) => my === reqRef.current && setStats(d))
      .catch((e) => {
        if (my !== reqRef.current) return;
        setFailed(true);
        toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      });
  }, [projectId, range, tc]);

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dayFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }), [locale]);
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");
  const busy = !stats && !failed;
  const pct = (v: number | null | undefined) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{t(`range_${range}` as "range_7d")}</p>
        <Segmented
          label={t("rangeLabel")}
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((r) => ({ value: r, label: r, srLabel: t(`range_${r}` as "range_7d") }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          icon={Activity}
          label={t("dau")}
          value={num(stats?.dau.devices)}
          loading={busy}
          hint={stats ? t("usersHint", { count: nf.format(stats.dau.users) }) : null}
        />
        <StatTile
          icon={Users}
          label={t("wau")}
          value={num(stats?.wau.devices)}
          loading={busy}
          hint={stats ? t("usersHint", { count: nf.format(stats.wau.users) }) : null}
        />
        <StatTile
          icon={Users}
          label={t("mau")}
          value={num(stats?.mau.devices)}
          loading={busy}
          hint={stats ? t("usersHint", { count: nf.format(stats.mau.users) }) : null}
        />
        <StatTile
          icon={Repeat}
          label={t("stickiness")}
          value={stats ? pct(stats.stickiness) : "—"}
          accent="success"
          loading={busy}
          hint={t("stickinessHint")}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("chartTitle")}</CardTitle>
            <CardDescription>{t("chartHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {stats ? (
            stats.buckets.some((b) => b.devices > 0) ? (
              <LiveChart
                label={t("chartTitle")}
                integerY
                area
                height={200}
                times={stats.buckets.map((b) => new Date(`${b.day}T00:00:00Z`).getTime())}
                formatY={(v) => nf.format(Math.round(v))}
                formatTime={(ms) => dayFmt.format(ms)}
                series={[
                  { key: "devices", label: t("activeDevices"), color: "var(--chart-1)", values: stats.buckets.map((b) => b.devices) },
                  { key: "users", label: t("activeUsers"), color: "var(--chart-2)", values: stats.buckets.map((b) => b.users) },
                ]}
              />
            ) : (
              <EmptyState icon={Activity} title={t("empty")} />
            )
          ) : (
            <EmptyState icon={Activity} title={failed ? tc("loadFailed") : tc("loading")} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <LineChart aria-hidden="true" className="h-4 w-4" /> {t("retentionTitle")}
            </CardTitle>
            <CardDescription>{t("retentionHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {ret && ret.cohorts.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left">
                <thead className="border-b border-border">
                  <tr className="text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
                    <th scope="col" className="px-5 py-2.5">{t("cohortDay")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right">{t("cohortSize")}</th>
                    {ret.offsets.map((n) => (
                      <th key={n} scope="col" className="px-3 py-2.5 text-right">D{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr className="bg-surface-muted/40">
                    <th scope="row" className="px-5 py-2.5 text-xs font-bold">{t("cohortAverage")}</th>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                      {nf.format(ret.summary[0]?.base ?? 0)}
                    </td>
                    {ret.summary.map((sm) => (
                      <td key={sm.offset} className="px-3 py-2.5 text-right text-xs font-bold tabular-nums">
                        {pct(sm.rate)}
                      </td>
                    ))}
                  </tr>
                  {ret.cohorts.map((c) => (
                    <tr key={c.day}>
                      <th scope="row" className="px-5 py-2.5 text-xs font-medium tabular-nums">{c.day}</th>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{nf.format(c.size)}</td>
                      {c.points.map((p) => (
                        <td
                          key={p.offset}
                          className="px-3 py-2.5 text-right text-xs tabular-nums"
                          // 아직 관측 기간이 오지 않은 칸은 값이 아니라 공백이다
                          style={p.rate === null ? undefined : { background: `color-mix(in oklab, var(--chart-1) ${Math.round(p.rate * 60)}%, transparent)` }}
                        >
                          {pct(p.rate)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={LineChart} title={ret ? t("empty") : tc("loading")} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{t("opensTitle")}</CardTitle>
              <CardDescription>{t("opensHint")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {stats ? (
              stats.buckets.some((b) => b.opens > 0) ? (
                <LiveChart
                  label={t("opensTitle")}
                  integerY
                  area
                  height={160}
                  times={stats.buckets.map((b) => new Date(`${b.day}T00:00:00Z`).getTime())}
                  formatY={(v) => nf.format(Math.round(v))}
                  formatTime={(ms) => dayFmt.format(ms)}
                  series={[{ key: "opens", label: t("opensTitle"), color: "var(--chart-2)", values: stats.buckets.map((b) => b.opens) }]}
                />
              ) : (
                <EmptyState icon={Activity} title={t("empty")} />
              )
            ) : (
              <EmptyState icon={Activity} title={failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{t("platformsTitle")}</CardTitle>
              <CardDescription>{t(`range_${range}` as "range_7d")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {stats && Object.keys(stats.platforms).length > 0 ? (
              <BarList
                rows={Object.entries(stats.platforms)
                  .sort((a, b) => b[1] - a[1])
                  .map(([p, v]) => ({ label: p, value: v }))}
              />
            ) : (
              <EmptyState icon={Smartphone} title={stats ? t("empty") : failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
