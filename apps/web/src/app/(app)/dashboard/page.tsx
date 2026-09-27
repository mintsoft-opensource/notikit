"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  FolderKanban, Activity, ArrowRight, Rocket, Send, Users, Smartphone,
  MousePointerClick, Inbox, Webhook, PackageMinus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { BarList } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { DonutChart } from "@/components/system/donut-chart";
import { useProjects, adminApi } from "@/lib/admin-client";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/number-format";

type SystemStats = {
  totals: { sends24h: number; recipients24h: number; success24h: number; queued: number; activeDevices: number; users: number };
  hourly: Array<{ ts: string; count: number; recipients: number; success: number }>;
  topProjects: Array<{ id: string; name: string; count: number }>;
  webhooks24h: { delivered: number; failed: number; pending: number };
  activity: {
    dau: { devices: number; users: number };
    mau: { devices: number; users: number };
    daily: Array<{ day: string; devices: number; users: number }>;
  };
  platforms: Array<{ platform: string; count: number }>;
  /** user_rate 는 분모가 0이면 null */
  clicks: { clicks: number; click_users: number; audience_users: number; user_rate: number | null };
  lifecycle: { uninstalled: number; reinstalled: number };
};

/** 차트 팔레트는 순번대로 배정하고 순환시키지 않는다 (globals.css 에서 CVD 검증됨) */
const SLICE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const ta = useTranslations("activity");
  const to = useTranslations("overview");
  const ts = useTranslations("system");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects, loading } = useProjects();
  const prod = projects.filter((p) => p.environment === "production").length;

  const [stats, setStats] = React.useState<SystemStats | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    adminApi<SystemStats>("/api/admin/system/stats")
      .then((d) => alive && setStats(d))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  const nf = useNumberFormat();
  // 일별 버킷은 UTC 자정으로 찍힌 날짜다 — 로컬로 포맷하면 UTC 보다 뒤처진 지역에서 하루 앞 날짜로 보인다
  const dayFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }), [locale]);
  const hourFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale]);
  const busy = !stats && !failed;
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");
  /** 분모가 0이면 비율은 정의되지 않는다 — 0% 는 "아무도 안 눌렀다"로 오독된다 */
  const pct = (v: number | null | undefined) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");

  const platformSlices = (stats?.platforms ?? [])
    .filter((p) => p.count > 0)
    .map((p, i) => ({ label: p.platform, value: p.count, color: SLICE_COLORS[i % SLICE_COLORS.length] }));

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={Activity}
          label={ta("dau")}
          value={num(stats?.activity.dau.devices)}
          accent="primary"
          loading={busy}
          hint={stats ? ta("usersHint", { count: nf.format(stats.activity.dau.users) }) : null}
        />
        <StatTile
          icon={Users}
          label={ta("mau")}
          value={num(stats?.activity.mau.devices)}
          loading={busy}
          hint={stats ? ta("usersHint", { count: nf.format(stats.activity.mau.users) }) : null}
        />
        <StatTile icon={Send} label={t("sends24h")} value={num(stats?.totals.sends24h)} loading={busy} />
        <StatTile
          icon={MousePointerClick}
          label={to("clickUserRate")}
          value={stats ? pct(stats.clicks.user_rate) : "—"}
          accent="success"
          loading={busy}
          hint={stats ? `${nf.format(stats.clicks.click_users)} / ${nf.format(stats.clicks.audience_users)}` : null}
        />
        <StatTile icon={Smartphone} label={t("activeDevices")} value={num(stats?.totals.activeDevices)} loading={busy} />
        <StatTile
          icon={Inbox}
          label={ts("statQueued")}
          value={num(stats?.totals.queued)}
          accent={stats && stats.totals.queued > 0 ? "warning" : "default"}
          loading={busy}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{ta("chartTitle")}</CardTitle>
              <CardDescription>{ta("range_30d")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {stats ? (
              stats.activity.daily.some((d) => d.devices > 0) ? (
                <LiveChart
                  label={ta("chartTitle")}
                  integerY
                  area
                  height={220}
                  times={stats.activity.daily.map((d) => new Date(`${d.day}T00:00:00Z`).getTime())}
                  formatY={(v) => nf.format(Math.round(v))}
                  formatTime={(ms) => dayFmt.format(ms)}
                  series={[
                    { key: "devices", label: ta("activeDevices"), color: "var(--chart-1)", values: stats.activity.daily.map((d) => d.devices) },
                    { key: "users", label: ta("activeUsers"), color: "var(--chart-2)", values: stats.activity.daily.map((d) => d.users) },
                  ]}
                />
              ) : (
                <EmptyState icon={Activity} title={ta("empty")} />
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
              <CardDescription>{t("platformsHint")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {platformSlices.length > 0 ? (
              <DonutChart label={t("platformsTitle")} slices={platformSlices} formatValue={(v) => nf.format(v)} />
            ) : (
              <EmptyState icon={Smartphone} title={stats ? ta("empty") : failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{ts("chartHourly")}</CardTitle>
              <CardDescription>{ts("range24h")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {stats && stats.hourly.some((h) => h.count > 0) ? (
              <LiveChart
                label={ts("chartHourly")}
                integerY
                area
                height={150}
                times={stats.hourly.map((h) => new Date(h.ts).getTime())}
                formatY={(v) => nf.format(Math.round(v))}
                formatTime={(ms) => hourFmt.format(ms)}
                series={[{ key: "sends", label: to("statSends"), color: "var(--chart-1)", values: stats.hourly.map((h) => h.count) }]}
              />
            ) : (
              <EmptyState icon={Send} title={stats ? ts("empty") : failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{t("topProjects")}</CardTitle>
              <CardDescription>{ts("range24h")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {stats && stats.topProjects.length > 0 ? (
              <BarList rows={stats.topProjects.map((p) => ({ label: p.name, value: p.count }))} />
            ) : (
              <EmptyState icon={FolderKanban} title={stats ? ts("empty") : failed ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{t("healthTitle")}</CardTitle>
              <CardDescription>{ts("range24h")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <StatTile icon={PackageMinus} label={to("statUninstalled")} value={num(stats?.lifecycle.uninstalled)} accent="danger" loading={busy} />
              <StatTile icon={Rocket} label={to("statReinstalled")} value={num(stats?.lifecycle.reinstalled)} accent="success" loading={busy} />
            </div>
            {stats && (stats.webhooks24h.delivered + stats.webhooks24h.failed + stats.webhooks24h.pending) > 0 ? (
              <BarList
                rows={[
                  { label: t("whDelivered"), value: stats.webhooks24h.delivered, color: "var(--success)" },
                  { label: t("whFailed"), value: stats.webhooks24h.failed, color: "var(--error)" },
                  { label: t("whPending"), value: stats.webhooks24h.pending, color: "var(--gy400)" },
                ]}
              />
            ) : (
              <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                <Webhook aria-hidden="true" className="size-4" /> {t("noWebhooks")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("projectsCount", { count: projects.length })}</CardTitle>
            <CardDescription>{t("productionHint", { count: prod })}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/projects">{t("quickProjects")}<ArrowRight aria-hidden="true" className="size-4" /></Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {loading && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-20 rounded-tile" />)}
          {!loading && projects.length === 0 && (
            <EmptyState
              className="lg:col-span-2"
              icon={FolderKanban}
              title={t("noProjects")}
              description={t("quickProjectsDesc")}
              action={<Button asChild size="sm"><Link href="/projects">{t("quickProjects")}<ArrowRight aria-hidden="true" className="size-4" /></Link></Button>}
            />
          )}
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className={cn(
                "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-tile border border-border px-3.5 py-2 transition-colors hover:border-primary/40 hover:bg-surface-muted",
                FOCUS_RING
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="truncate font-mono text-2xs text-muted-foreground">{p.apiKey}</p>
              </div>
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
