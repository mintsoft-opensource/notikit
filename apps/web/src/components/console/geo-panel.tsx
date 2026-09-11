"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Globe, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { adminApi } from "@/lib/admin-client";

type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  countries: number;
  ipv4: number;
  ipv6: number;
  error: string | null;
};

type GeoRes = {
  runs: Run[];
  current: { countries: number; ipv4: number; ipv6: number };
  trustedProxyHops: number;
};

const statusVariant = (s: string) => (s === "ok" ? "success" : s === "failed" ? "danger" : "warning");

/** 위치 데이터 적재 이력 — superadmin 전용. /system 에 붙는다. */
export function GeoPanel() {
  const t = useTranslations("system");
  const locale = useLocale();
  const [data, setData] = React.useState<GeoRes | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    adminApi<GeoRes>("/api/admin/system/geo")
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  const df = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }),
    [locale]
  );
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const busy = !data && !error;
  const cur = data?.current;
  const never = data && cur && cur.countries === 0 && cur.ipv4 === 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile loading={busy} icon={Globe} label={t("geoCountries")} value={cur ? nf.format(cur.countries) : "—"} />
        <StatTile loading={busy} icon={Globe} label={t("geoIpv4")} value={cur ? nf.format(cur.ipv4) : "—"} />
        <StatTile loading={busy} icon={Globe} label={t("geoIpv6")} value={cur ? nf.format(cur.ipv6) : "—"} />
      </div>

      {/* 데이터가 있어도 프록시를 신뢰하지 않으면 국가가 기록되지 않는다 — 그 상태를 드러낸다 */}
      {data?.trustedProxyHops === 0 && (
        <div className="flex gap-2 border-l-2 border-warning bg-warning/5 px-3 py-2">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="text-sm leading-relaxed text-foreground/80">{t("geoProxyWarn")}</p>
        </div>
      )}

      <Card className="min-w-0 rounded-none">
        <CardHeader>
          <div>
            <CardTitle>{t("geoTitle")}</CardTitle>
            <CardDescription>{t("geoSubtitle")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {busy && (
            <div className="space-y-3 p-3.5">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {never && <EmptyState icon={Globe} title={t("geoNever")} description={t("geoRunHint")} />}
          {data && !never && data.runs.length === 0 && <EmptyState icon={Globe} title={t("geoEmpty")} description={t("geoRunHint")} />}
          {data && data.runs.length > 0 && (
            <>
              <div className="hidden gap-x-4 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground lg:grid-cols-[13rem_6rem_minmax(0,1fr)_6rem] lg:grid">
                <span>{t("geoColAt")}</span>
                <span>{t("geoColStatus")}</span>
                <span>{t("geoColCounts")}</span>
                <span className="text-right">{t("geoColTook")}</span>
              </div>
              <ul className="divide-y divide-border">
                {data.runs.map((r) => {
                  const took = r.finishedAt
                    ? Math.max(0, (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
                    : null;
                  return (
                    <li
                      key={r.id}
                      className="grid min-h-12 gap-x-4 gap-y-1 px-3.5 py-2.5 lg:grid-cols-[13rem_6rem_minmax(0,1fr)_6rem] lg:items-center"
                    >
                      <time dateTime={r.startedAt} className="text-xs tabular-nums text-muted-foreground">
                        {df.format(new Date(r.startedAt))}
                      </time>
                      <div><Badge variant={statusVariant(r.status)}>{r.status}</Badge></div>
                      <span className="truncate text-xs text-muted-foreground">
                        {t("geoCountries")} {nf.format(r.countries)} · IPv4 {nf.format(r.ipv4)} · IPv6 {nf.format(r.ipv6)}
                        {r.error ? ` · ${r.error}` : ""}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground lg:text-right">
                        {took === null ? "—" : `${took.toFixed(1)}s`}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-border px-3.5 py-2 text-2xs text-muted-foreground">
                {t("geoAttribution")}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
