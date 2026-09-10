"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Smartphone, ShieldCheck, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile } from "@/components/console/panels";
import { adminApi } from "@/lib/admin-client";

type Device = {
  id: string;
  tokenPreview: string;
  platform: string;
  isActive: boolean;
  appVersion: string | null;
  osVersion: string | null;
  locale: string | null;
  country: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  externalId: string | null;
};
/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;

/** 커서를 쿼리스트링으로 */
function cursorQuery(c: Cursor): string {
  return c ? `before=${encodeURIComponent(c.ts)}&before_id=${encodeURIComponent(c.id)}` : "";
}

type Summary = { total: number; active: number; anonymous: number };
type CheckResult = { checked: number; invalid: number; deactivated: number; skipped: boolean };

const PLATFORMS = ["android", "ios", "web", "webview", "electron", "flutter", "react-native"];

/** 디바이스 목록 + 죽은 토큰 정리(FCM dry-run). 토큰 원문은 노출하지 않는다. */
export function DevicesConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [platform, setPlatform] = React.useState("");
  const [active, setActive] = React.useState("");
  const [devices, setDevices] = React.useState<Device[] | null>(null);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [checking, setChecking] = React.useState(false);
  const reqRef = React.useRef(0);

  const query = React.useCallback(
    (cursor?: Cursor) => {
      const p = new URLSearchParams();
      if (platform) p.set("platform", platform);
      if (active) p.set("active", active);
      if (cursor) { p.set("before", cursor.ts); p.set("before_id", cursor.id); }
      return p.toString();
    },
    [platform, active]
  );

  const load = React.useCallback(async () => {
    const my = ++reqRef.current;
    setDevices(null);
    try {
      const d = await adminApi<{ devices: Device[]; summary: Summary; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/devices?${query()}`
      );
      if (my !== reqRef.current) return;
      setDevices(d.devices);
      setSummary(d.summary);
      setNext(d.next);
    } catch (e) {
      if (my !== reqRef.current) return;
      setDevices([]);
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }, [projectId, query, tc]);

  React.useEffect(() => { void load(); }, [load]);

  /** 죽은 토큰 정리 — dry-run 이라 유저에게 알림이 가지 않는다 */
  async function checkTokens() {
    if (checking) return;
    setChecking(true);
    try {
      const r = await adminApi<CheckResult>(
        `/api/admin/projects/${projectId}/devices/check?min_interval_hours=0`,
        { method: "POST", body: "{}" }
      );
      if (r.skipped) toast.error(t("checkSkipped"));
      else toast.success(t("checkDone", { checked: r.checked, deactivated: r.deactivated }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    } finally {
      setChecking(false);
    }
  }

  async function loadMore() {
    if (!next) return;
    try {
      const d = await adminApi<{ devices: Device[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/devices?${query(next)}`
      );
      setDevices((cur) => [...(cur ?? []), ...d.devices]);
      setNext(d.next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title={t("devicesTitle")}
        description={t("devicesSubtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={checkTokens} disabled={checking}>
            <ShieldCheck aria-hidden="true" className="h-4 w-4" /> {checking ? t("checking") : t("checkTokens")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Smartphone} label={t("statTotal")} value={num(summary?.total)} loading={!summary} />
        <StatTile icon={ShieldCheck} label={t("statActive")} value={num(summary?.active)} accent="success" loading={!summary} />
        <StatTile
          icon={Smartphone}
          label={t("statAnonymous")}
          value={num(summary?.anonymous)}
          loading={!summary}
          hint={t("anonymousHint")}
        />
        <StatTile
          icon={RefreshCw}
          label={t("statInactive")}
          value={summary ? nf.format(summary.total - summary.active) : "—"}
          accent="warning"
          loading={!summary}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label={t("filterPlatform")} className="w-auto">
          <option value="">{t("allPlatforms")}</option>
          {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={active} onChange={(e) => setActive(e.target.value)} aria-label={t("filterActive")} className="w-auto">
          <option value="">{t("allStates")}</option>
          <option value="true">{t("statActive")}</option>
          <option value="false">{t("statInactive")}</option>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {!devices && <div className="space-y-3 p-5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {devices && devices.length === 0 && <EmptyState icon={Smartphone} title={t("noDevices")} />}
          {devices && devices.length > 0 && (
            <>
              <ul className="divide-y divide-border">
                {devices.map((d) => (
                  <li key={d.id} className="grid gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_8rem_10rem] xl:items-center">
                    <p className="truncate text-sm font-semibold">{d.externalId ?? <span className="font-normal text-muted-foreground">{t("anonymousDevice")}</span>}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{d.tokenPreview}</p>
                    <Badge variant="neutral">{d.platform}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {[d.appVersion, d.osVersion].filter(Boolean).join(" · ") || "—"}
                    </span>
                    <div className="flex items-center justify-between gap-2 xl:justify-end">
                      <time dateTime={d.lastActiveAt ?? undefined} className="text-xs tabular-nums text-muted-foreground">
                        {d.lastActiveAt ? df.format(new Date(d.lastActiveAt)) : "—"}
                      </time>
                      <Badge variant={d.isActive ? "success" : "danger"}>
                        {d.isActive ? t("statActive") : t("statInactive")}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
              {next && (
                <div className="flex justify-center border-t border-border p-3">
                  <Button variant="outline" size="sm" onClick={loadMore}>{tc("loadMore")}</Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
