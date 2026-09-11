"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { PackageMinus, PackagePlus, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { adminApi } from "@/lib/admin-client";

type Lifecycle = {
  devices_lifecycle: {
    uninstalled: number;
    reinstalled: number;
    net: number;
    buckets: Array<{ ts: string; count: number }>;
  };
};

/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;

/** 커서를 쿼리스트링으로 */
function cursorQuery(c: Cursor): string {
  return c ? `before=${encodeURIComponent(c.ts)}&before_id=${encodeURIComponent(c.id)}` : "";
}

type DeviceEvent = {
  id: string;
  event: string;
  source: string;
  platform: string | null;
  at: string;
  externalId: string | null;
};

type RangeKey = "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["24h", "7d", "30d"];

/** 설치 변동 — 앱 삭제/재설치 추이와 전체 이벤트 로그. */
export function InstallsConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("installs");
  const to = useTranslations("overview");
  const ts = useTranslations("system");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [range, setRange] = React.useState<RangeKey>("7d");
  const [stats, setStats] = React.useState<Lifecycle | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [event, setEvent] = React.useState("");
  const [events, setEvents] = React.useState<DeviceEvent[] | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [more, setMore] = React.useState(false);
  const reqRef = React.useRef(0);
  const evtRef = React.useRef(0);

  React.useEffect(() => {
    const my = ++reqRef.current;
    setStats(null);
    setFailed(false);
    adminApi<Lifecycle>(`/api/admin/projects/${projectId}/stats?range=${range}`)
      .then((d) => my === reqRef.current && setStats(d))
      .catch((e) => {
        if (my !== reqRef.current) return;
        setFailed(true);
        toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      });
  }, [projectId, range, tc]);

  React.useEffect(() => {
    const my = ++evtRef.current;
    setEvents(null);
    const q = event ? `?event=${event}` : "";
    adminApi<{ events: DeviceEvent[]; next: Cursor }>(`/api/admin/projects/${projectId}/device-events${q}`)
      .then((d) => {
        if (my !== evtRef.current) return;
        setEvents(d.events);
        setNext(d.next);
      })
      .catch(() => evtRef.current === my && setEvents([]));
  }, [projectId, event]);

  async function loadMore() {
    if (!next || more) return;
    setMore(true);
    try {
      const q = new URLSearchParams();
      if (event) q.set("event", event);
      q.set("before", next.ts);
      q.set("before_id", next.id);
      const d = await adminApi<{ events: DeviceEvent[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/device-events?${q}`
      );
      setEvents((cur) => [...(cur ?? []), ...d.events]);
      setNext(d.next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    } finally {
      setMore(false);
    }
  }

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
  const lc = stats?.devices_lifecycle;
  const rangeLabelOf = (r: RangeKey) => (r === "24h" ? ts("range24h") : r === "7d" ? ts("range7d") : ts("range30d"));

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={to("uninstallHint")} />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{rangeLabelOf(range)}</p>
        <Segmented
          label={rangeLabelOf(range)}
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((r) => ({ value: r, label: r, srLabel: rangeLabelOf(r) }))}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile icon={PackageMinus} label={to("statUninstalled")} value={busy ? "—" : nf.format(lc?.uninstalled ?? 0)} accent="danger" loading={busy} />
        <StatTile icon={PackagePlus} label={to("statReinstalled")} value={busy ? "—" : nf.format(lc?.reinstalled ?? 0)} accent="success" loading={busy} />
        <StatTile
          icon={lc && lc.net < 0 ? TrendingDown : TrendingUp}
          label={to("statNetDevices")}
          value={lc ? (lc.net > 0 ? `+${nf.format(lc.net)}` : nf.format(lc.net)) : "—"}
          accent={lc && lc.net < 0 ? "danger" : "success"}
          loading={busy}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{to("chartUninstalls")}</CardTitle>
            <CardDescription>{rangeLabelOf(range)}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {stats ? (
            lc && lc.buckets.some((b) => b.count > 0) ? (
              <LiveChart
                label={to("chartUninstalls")}
                integerY
                area
                height={200}
                times={lc.buckets.map((b) => new Date(b.ts).getTime())}
                formatY={(v) => nf.format(Math.round(v))}
                formatTime={(ms) => bucketFmt.format(ms)}
                series={[{ key: "uninstalls", label: to("statUninstalled"), color: "var(--error)", values: lc.buckets.map((b) => b.count) }]}
              />
            ) : (
              <EmptyState icon={PackageMinus} title={to("noUninstalls")} />
            )
          ) : (
            <EmptyState icon={PackageMinus} title={failed ? tc("loadFailed") : tc("loading")} />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{t("eventLog")}</p>
        <Select value={event} onChange={(e) => setEvent(e.target.value)} aria-label={t("filterEvent")} className="w-auto">
          <option value="">{t("allEvents")}</option>
          <option value="uninstalled">{to("eventUninstalled")}</option>
          <option value="reinstalled">{to("eventReinstalled")}</option>
        </Select>
      </div>

      <Card className="rounded-none">
        <CardContent className="p-0">
          {!events && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {events && events.length === 0 && <EmptyState icon={PackageMinus} title={to("noUninstalls")} />}
          {events && events.length > 0 && (
            <>
              <DataTable label={t("eventLog")} rowCount={events.length + 1}>
              <TableHeader
                grid="sm:grid-cols-[5rem_minmax(0,1fr)_7rem_minmax(0,1fr)_10rem]"
                show="sm"
                columns={[
                  { label: t("colEvent") },
                  { label: t("colUser") },
                  { label: t("colPlatform") },
                  { label: t("colSource") },
                  { label: t("colAt"), align: "end" },
                ]}
              />
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[5rem_minmax(0,1fr)_7rem_minmax(0,1fr)_10rem] sm:items-center">
                    <TableCell label={t("colEvent")}>
                      <Badge variant={e.event === "uninstalled" ? "danger" : "success"}>
                        {e.event === "uninstalled" ? to("eventUninstalled") : to("eventReinstalled")}
                      </Badge>
                    </TableCell>
                    <TableCell label={t("colUser")} className="truncate font-mono text-sm font-semibold">
                      {e.externalId ?? <span className="font-sans font-normal text-muted-foreground">{to("anonymousDevice")}</span>}
                    </TableCell>
                    <TableCell label={t("colPlatform")} className="text-xs text-muted-foreground">{e.platform ?? "—"}</TableCell>
                    <TableCell label={t("colSource")} className="truncate text-xs text-muted-foreground">{to(`source_${e.source}` as "source_send")}</TableCell>
                    <TableCell label={t("colAt")} className="text-xs tabular-nums text-muted-foreground sm:text-right">
                      {df.format(new Date(e.at))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </DataTable>
              {next && (
                <div className="flex justify-center border-t border-border p-3">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={more}>
                    {more ? tc("loading") : tc("loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
