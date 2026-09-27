"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Cpu, MemoryStick, HardDrive, Timer, Database, Clock, Send, Users, Smartphone, Percent, Inbox, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile, EmptyState, DataRow, SectionTitle, BarList, Segmented, formatDuration } from "@/components/console/panels";
import { LiveChart, formatBytes } from "@/components/system/live-chart";
import { GeoPanel } from "@/components/console/geo-panel";
import { adminApi } from "@/lib/admin-client";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/number-format";

type SystemStats = {
  totals: { sends24h: number; recipients24h: number; success24h: number; queued: number; activeDevices: number; users: number };
  hourly: Array<{ ts: string; count: number }>;
  statuses: Record<string, number>;
  topProjects: Array<{ id: string; name: string; count: number }>;
  webhooks24h: { delivered: number; failed: number; pending: number };
  activity: {
    dau: { devices: number; users: number };
    mau: { devices: number; users: number };
    daily: Array<{ day: string; devices: number; users: number }>;
  };
};

type HostStats = {
  host: {
    cpu: { usagePct: number | null; loadavg: [number, number, number]; cores: number };
    memory: { totalBytes: number; usedBytes: number; processRssBytes: number; heapUsedBytes: number };
    network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
    eventLoop: { p50Ms: number; p99Ms: number } | null;
    uptimeSec: number;
    processUptimeSec: number;
    platform: string;
  };
  db: { latencyMs: number };
  queue: { queued: number; processing: number; scheduled: number; oldestQueuedSec: number | null };
  at: string;
};

type HostPoint = { t: number; cpu: number | null; memPct: number | null; rx: number | null; tx: number | null };

type HistoryPoint = { at: string; cpuPct: number | null; memPct: number | null; netRxBps: number | null; netTxBps: number | null };
type HistoryRes = { range: string; points: HistoryPoint[] };

/** 실시간(메모리 5분) vs 저장 이력(DB) */
type Window = "live" | "1h" | "24h" | "7d";
const WINDOWS: Window[] = ["live", "1h", "24h", "7d"];

const POLL_MS = 5000;
const WINDOW = 60; // 5분 (60 × 5s)
const MEM_WARN = 90; // 이 이상이면 수치에 경고색 — 색만으로 전달하지 않도록 힌트에 사용량 병기

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--success)",
  failed: "var(--error)",
  processing: "var(--primary)",
  scheduled: "var(--warning)",
  queued: "var(--gy400)",
};

/** 카드 헤더 — 제목 + 부제 (goji CardHeader 는 flex 라 좌측 블록으로 감싼다) */
function PanelHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <CardHeader>
      <div>
        <CardTitle>{title}</CardTitle>
        {sub && <CardDescription>{sub}</CardDescription>}
      </div>
    </CardHeader>
  );
}

/** 호스트 실시간 섹션 — 5초 폴링, 5분 롤링 윈도우 */
function HostSection() {
  const t = useTranslations("system");
  const locale = useLocale();
  const [latest, setLatest] = React.useState<HostStats | null>(null);
  const [points, setPoints] = React.useState<HostPoint[]>([]);
  const [error, setError] = React.useState(false);
  const [win, setWin] = React.useState<Window>("live");
  const [history, setHistory] = React.useState<HistoryPoint[] | null>(null);
  const nf = useNumberFormat({ maximumFractionDigits: 1 });
  const tfm = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }), [locale]);
  const tfLong = React.useMemo(
    () => new Intl.DateTimeFormat(locale, win === "7d" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }),
    [locale, win]
  );

  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 응답이 온 뒤에 다음 요청을 예약한다 — setInterval 은 느린 응답 위에 요청을 겹쳐 쌓고 순서가 뒤집힐 수 있다
    async function poll() {
      try {
        const d = await adminApi<HostStats>("/api/admin/system/host");
        if (!alive) return;
        setError(false);
        setLatest(d);
        setPoints((prev) =>
          [
            ...prev,
            {
              t: new Date(d.at).getTime(),
              cpu: d.host.cpu.usagePct,
              memPct: (d.host.memory.usedBytes / d.host.memory.totalBytes) * 100,
              rx: d.host.network?.rxBytesPerSec ?? null,
              tx: d.host.network?.txBytesPerSec ?? null,
            },
          ].slice(-WINDOW)
        );
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) timer = setTimeout(poll, POLL_MS);
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // 저장 이력 — 실시간이 아닐 때만 조회 (윈도우 전환 시 옛 응답이 덮어쓰지 않도록 시퀀스 가드)
  const histRef = React.useRef(0);
  React.useEffect(() => {
    if (win === "live") {
      setHistory(null);
      return;
    }
    const my = ++histRef.current;
    setHistory(null);
    adminApi<HistoryRes>(`/api/admin/system/history?range=${win}`)
      .then((d) => my === histRef.current && setHistory(d.points))
      .catch(() => my === histRef.current && setHistory([]));
  }, [win]);

  const h = latest?.host;
  const q = latest?.queue;
  const val = (s: string | null | undefined) => s ?? "—";
  const busy = !latest && !error;
  const memPct = h ? (h.memory.usedBytes / h.memory.totalBytes) * 100 : null;
  const live = win === "live";
  const src: HostPoint[] = live
    ? points
    : (history ?? []).map((p) => ({
        t: new Date(p.at).getTime(),
        cpu: p.cpuPct,
        memPct: p.memPct,
        rx: p.netRxBps,
        tx: p.netTxBps,
      }));
  const times = src.map((p) => p.t);
  const fmtTime = (ms: number) => (live ? tfm.format(ms) : tfLong.format(ms));
  const ready = live ? points.length > 1 : history != null && history.length > 1;
  const windowLabel =
    win === "live" ? t("rangeLive") : win === "1h" ? t("rangeStored1h") : win === "24h" ? t("rangeStored24h") : t("rangeStored7d");
  const chartEmpty = live ? t("collecting") : history == null ? t("collecting") : t("historyEmpty");

  return (
    <section className="space-y-4">
      <SectionTitle
        right={
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-1.5 text-2xs text-muted-foreground sm:flex">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${error ? "bg-error" : "bg-success"}`} />
              {error ? t("hostUnreachable") : live ? t("autoRefresh") : t("historyNote")}
            </span>
            <Segmented
              label={windowLabel}
              value={win}
              onChange={setWin}
              options={WINDOWS.map((w) => ({
                value: w,
                label: w === "live" ? t("live") : w === "1h" ? t("history1h") : w === "24h" ? t("history24h") : t("history7d"),
              }))}
            />
          </div>
        }
      >
        {t("host")}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={Cpu}
          loading={busy}
          label={t("cpu")}
          value={val(h ? (h.cpu.usagePct != null ? `${nf.format(h.cpu.usagePct)}%` : "—") : null)}
          hint={h ? `${h.cpu.cores} cores · load ${nf.format(h.cpu.loadavg[0])}` : null}
        />
        <StatTile
          icon={MemoryStick}
          label={t("memory")}
          value={val(memPct == null ? null : `${nf.format(memPct)}%`)}
          hint={h ? `${formatBytes(h.memory.usedBytes, locale)} / ${formatBytes(h.memory.totalBytes, locale)}` : null}
          accent={memPct != null && memPct >= MEM_WARN ? "warning" : "default"}
          loading={busy}
        />
        <StatTile
          icon={HardDrive}
          loading={busy}
          label="RSS"
          value={val(h ? formatBytes(h.memory.processRssBytes, locale) : null)}
          hint={h ? `heap ${formatBytes(h.memory.heapUsedBytes, locale)}` : null}
        />
        <StatTile
          icon={Timer}
          loading={busy}
          label={t("eventLoop")}
          value={val(h ? (h.eventLoop ? `${nf.format(h.eventLoop.p99Ms)} ms` : "—") : null)}
          hint={h?.eventLoop ? `p50 ${nf.format(h.eventLoop.p50Ms)} ms` : null}
        />
        <StatTile icon={Database} label={t("dbLatency")} value={val(latest ? `${nf.format(latest.db.latencyMs)} ms` : null)} />
        <StatTile
          icon={Clock}
          loading={busy}
          label={t("uptime")}
          value={val(h ? formatDuration(h.processUptimeSec) : null)}
          hint={h ? `host ${formatDuration(h.uptimeSec)}` : null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <PanelHead title={t("chartCpu")} sub={windowLabel} />
          <CardContent>
            {ready ? (
              <LiveChart
                label={t("chartCpu")}
                times={times}
                maxY={100}
                area
                height={170}
                formatY={(v) => `${Math.round(v)}%`}
                formatTime={fmtTime}
                series={[{ key: "cpu", label: "CPU", color: "var(--chart-1)", values: src.map((p) => p.cpu) }]}
              />
            ) : (
              <EmptyState icon={Activity} title={chartEmpty} />
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <PanelHead title={t("chartMemory")} sub={windowLabel} />
          <CardContent>
            {ready ? (
              <LiveChart
                label={t("chartMemory")}
                times={times}
                maxY={100}
                area
                height={170}
                formatY={(v) => `${Math.round(v)}%`}
                formatTime={fmtTime}
                series={[{ key: "mem", label: t("memory"), color: "var(--chart-1)", values: src.map((p) => p.memPct) }]}
              />
            ) : (
              <EmptyState icon={Activity} title={chartEmpty} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="min-w-0">
          <PanelHead title={t("chartNetwork")} sub={windowLabel} />
          <CardContent>
            {ready && src.some((p) => p.rx != null) ? (
              <LiveChart
                label={t("chartNetwork")}
                times={times}
                height={170}
                formatY={(v) => `${formatBytes(v, locale)}/s`}
                formatTime={fmtTime}
                series={[
                  { key: "rx", label: t("rx"), color: "var(--chart-1)", values: src.map((p) => p.rx) },
                  { key: "tx", label: t("tx"), color: "var(--chart-2)", values: src.map((p) => p.tx) },
                ]}
              />
            ) : (
              <EmptyState icon={Activity} title={ready ? t("netUnavailable") : chartEmpty} />
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <PanelHead title={t("queueTitle")} />
          <CardContent>
            <dl className="space-y-4">
              <DataRow label={t("queueQueued")} value={val(q ? String(q.queued) : null)} />
              <DataRow label={t("queueProcessing")} value={val(q ? String(q.processing) : null)} />
              <DataRow label={t("queueScheduled")} value={val(q ? String(q.scheduled) : null)} />
              <DataRow
                label={t("oldestQueued")}
                value={val(q ? (q.oldestQueuedSec != null ? formatDuration(q.oldestQueuedSec) : "—") : null)}
                tone={q?.oldestQueuedSec != null && q.oldestQueuedSec > 300 ? "warning" : "default"}
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default function SystemPage() {
  const t = useTranslations("system");
  const ta = useTranslations("activity");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [stats, setStats] = React.useState<SystemStats | null>(null);
  const [error, setError] = React.useState(false);
  const [retryN, setRetryN] = React.useState(0);
  const nf = useNumberFormat();
  const hf = React.useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale]);

  React.useEffect(() => {
    let alive = true;
    setError(false);
    adminApi<SystemStats>("/api/admin/system/stats")
      .then((d) => alive && setStats(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [retryN]);

  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");
  const statsBusy = !stats && !error;
  // DAU/MAU — 재방문 비율. MAU 가 0 이면 나눗셈이 무의미하므로 값을 비운다.
  const stickiness =
    stats && stats.activity.mau.devices > 0
      ? `${((stats.activity.dau.devices / stats.activity.mau.devices) * 100).toFixed(1)}%`
      : "—";
  const successRate =
    stats && stats.totals.recipients24h > 0
      ? `${((stats.totals.success24h / stats.totals.recipients24h) * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <HostSection />

      <section className="space-y-4">
        <SectionTitle>{t("delivery")}</SectionTitle>

        {error && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-between rounded-tile border border-border bg-surface-muted px-4 py-2.5 text-sm text-muted-foreground"
          >
            <span>{tc("loadFailed")}</span>
            <button
              type="button"
              onClick={() => setRetryN((n) => n + 1)}
              className={cn("rounded-sm font-bold text-primary hover:underline", FOCUS_RING)}
            >
              {tc("retry")}
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <StatTile loading={statsBusy} icon={Send} label={t("statSends")} value={num(stats?.totals.sends24h)} />
          <StatTile loading={statsBusy} icon={Inbox} label={t("statRecipients")} value={num(stats?.totals.recipients24h)} />
          <StatTile loading={statsBusy} icon={Percent} label={t("statSuccessRate")} value={successRate} accent="success" />
          <StatTile loading={statsBusy} icon={Smartphone} label={t("statActiveDevices")} value={num(stats?.totals.activeDevices)} />
          <StatTile loading={statsBusy} icon={Users} label={t("statUsers")} value={num(stats?.totals.users)} />
        </div>

        <SectionTitle>{ta("title")}</SectionTitle>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile loading={statsBusy} icon={Activity} label={ta("dau")} value={num(stats?.activity.dau.devices)}
            hint={stats ? ta("usersHint", { count: nf.format(stats.activity.dau.users) }) : null} />
          <StatTile loading={statsBusy} icon={Users} label={ta("mau")} value={num(stats?.activity.mau.devices)}
            hint={stats ? ta("usersHint", { count: nf.format(stats.activity.mau.users) }) : null} />
          <StatTile loading={statsBusy} icon={Percent} label={ta("stickiness")} value={stickiness} />
          <StatTile loading={statsBusy} icon={Smartphone} label={t("statActiveDevices")} value={num(stats?.totals.activeDevices)} />
        </div>

        <Card className="min-w-0">
          <PanelHead title={ta("chartTitle")} sub={ta("chartHint")} />
          <CardContent>
            {stats && stats.activity.daily.length > 0 ? (
              <LiveChart
                label={ta("chartTitle")}
                times={stats.activity.daily.map((d) => new Date(d.day).getTime())}
                height={190}
                formatY={(v) => nf.format(v)}
                formatTime={(ms) => new Date(ms).toISOString().slice(5, 10)}
                series={[
                  { key: "devices", label: ta("activeDevices"), color: "var(--chart-1)", values: stats.activity.daily.map((d) => d.devices) },
                  { key: "users", label: ta("activeUsers"), color: "var(--chart-2)", values: stats.activity.daily.map((d) => d.users) },
                ]}
              />
            ) : (
              <EmptyState icon={Activity} title={ta("empty")} />
            )}
          </CardContent>
        </Card>

        <SectionTitle>{t("geoTitle")}</SectionTitle>
        <GeoPanel />

        <Card>
          <PanelHead title={t("chartHourly")} sub={t("range24h")} />
          <CardContent>
            {stats ? (
              stats.hourly.some((h) => h.count > 0) ? (
                <LiveChart
                  label={t("chartHourly")}
                  integerY
                  times={stats.hourly.map((h) => new Date(h.ts).getTime())}
                  area
                  height={190}
                  formatY={(v) => nf.format(Math.round(v))}
                  formatTime={(ms) => hf.format(ms)}
                  series={[{ key: "sends", label: t("statSends"), color: "var(--chart-1)", values: stats.hourly.map((h) => h.count) }]}
                />
              ) : (
                <EmptyState icon={Send} title={t("empty")} />
              )
            ) : (
              <EmptyState icon={Send} title={error ? tc("loadFailed") : tc("loading")} />
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="min-w-0">
            <PanelHead title={t("chartStatuses")} sub={t("range24h")} />
            <CardContent>
              {stats && Object.keys(stats.statuses).length > 0 ? (
                <BarList
                  rows={Object.entries(stats.statuses)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, v]) => ({ label: s, value: v, color: STATUS_COLOR[s] ?? "var(--gy400)" }))}
                />
              ) : (
                <EmptyState icon={Activity} title={stats ? t("empty") : error ? tc("loadFailed") : tc("loading")} />
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <PanelHead title={t("topProjects")} sub={t("range24h")} />
            <CardContent>
              {stats && stats.topProjects.length > 0 ? (
                <BarList rows={stats.topProjects.map((p) => ({ label: p.name, value: p.count }))} />
              ) : (
                <EmptyState icon={Send} title={stats ? t("empty") : error ? tc("loadFailed") : tc("loading")} />
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <PanelHead title={t("webhooks")} sub={t("range24h")} />
            <CardContent>
              <dl className="space-y-4">
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--success)" }} />
                      {t("whDelivered")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.delivered)}
                />
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--error)" }} />
                      {t("whFailed")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.failed)}
                  tone={stats && stats.webhooks24h.failed > 0 ? "danger" : "default"}
                />
                <DataRow
                  label={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--gy400)" }} />
                      {t("whPending")}
                    </span>
                  }
                  value={num(stats?.webhooks24h.pending)}
                />
              </dl>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
