"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { PackageMinus, PackagePlus, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/ui/eyebrow";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, Segmented } from "@/components/console/panels";
import { LiveChart } from "@/components/system/live-chart";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { useNumberFormat } from "@/lib/number-format";

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
  const errorText = useAdminErrorText();
  const locale = useLocale();

  const [range, setRange] = React.useState<RangeKey>("7d");
  const [stats, setStats] = React.useState<Lifecycle | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [event, setEvent] = React.useState("");
  const [events, setEvents] = React.useState<DeviceEvent[] | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [more, setMore] = React.useState(false);
  const reqRef = React.useRef(0);
  // 이벤트 목록 요청 세대 — 필터가 바뀌면 올라가고, "더 보기"는 같은 세대인지만 본다
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
        toast.error(errorText(e, tc("loadFailed")));
      });
  }, [projectId, range, tc, errorText]);

  React.useEffect(() => {
    const my = ++evtRef.current;
    setEvents(null);
    setNext(null);
    setMore(false);
    const q = event ? `?${new URLSearchParams({ event })}` : "";
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
    // 세대를 올리지 않고 붙잡아 둔다 — 그사이 필터가 바뀌면 옛 필터의 다음 페이지를 새 목록에 붙이지 않는다
    const my = evtRef.current;
    setMore(true);
    try {
      const q = new URLSearchParams();
      if (event) q.set("event", event);
      q.set("before", next.ts);
      q.set("before_id", next.id);
      const d = await adminApi<{ events: DeviceEvent[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/device-events?${q}`
      );
      if (my !== evtRef.current) return;
      setEvents((cur) => [...(cur ?? []), ...d.events]);
      setNext(d.next);
    } catch (e) {
      if (my !== evtRef.current) return;
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === evtRef.current) setMore(false);
    }
  }

  const nf = useNumberFormat();
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
        <Eyebrow>{rangeLabelOf(range)}</Eyebrow>
        <Segmented
          label={rangeLabelOf(range)}
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((r) => ({ value: r, label: r, srLabel: rangeLabelOf(r) }))}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
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
          {busy ? (
            <Skeleton className="h-50 w-full" />
          ) : lc && lc.buckets.some((b) => b.count > 0) ? (
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
            <EmptyState icon={PackageMinus} title={failed ? tc("loadFailed") : to("noUninstalls")} />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>{t("eventLog")}</Eyebrow>
        <Select value={event} onChange={(e) => setEvent(e.target.value)} aria-label={t("filterEvent")} className="w-auto">
          <option value="">{t("allEvents")}</option>
          <option value="uninstalled">{to("eventUninstalled")}</option>
          <option value="reinstalled">{to("eventReinstalled")}</option>
        </Select>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!events && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
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
                    <TableCell label={t("colPlatform")} className={FIELD_HINT_TEXT}>{e.platform ?? "—"}</TableCell>
                    <TableCell label={t("colSource")} className="truncate text-xs text-muted-foreground">{to(`source_${e.source}` as "source_send")}</TableCell>
                    <TableCell label={t("colAt")} className="text-xs tabular-nums text-muted-foreground sm:text-end">
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
