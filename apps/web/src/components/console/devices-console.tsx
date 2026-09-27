"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Smartphone, ShieldCheck, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile } from "@/components/console/panels";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { useNumberFormat } from "@/lib/number-format";

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
  /** FCM 이 받아준 적이 있으면 그 시각 — null 이면 아직 실재가 확인되지 않았다 */
  verifiedAt: string | null;
  createdAt: string;
  externalId: string | null;
};
/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;

type Summary = { total: number; active: number; anonymous: number; unverified: number };
type CheckResult = { checked: number; invalid: number; deactivated: number; skipped: boolean };

const PLATFORMS = ["android", "ios", "web", "webview", "electron", "flutter", "react-native"];

/** 디바이스 목록 + 죽은 토큰 정리(FCM dry-run). 토큰 원문은 노출하지 않는다. */
export function DevicesConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();

  const [platform, setPlatform] = React.useState("");
  const [active, setActive] = React.useState("");
  const [devices, setDevices] = React.useState<Device[] | null>(null);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [checking, setChecking] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // 요청 세대 — 초기 로드가 올리고 "더 보기"는 같은 세대인지만 본다
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
    setNext(null);
    setLoadingMore(false);
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
      toast.error(errorText(e, tc("loadFailed")));
    }
  }, [projectId, query, tc, errorText]);

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
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      setChecking(false);
    }
  }

  async function loadMore() {
    if (!next || loadingMore) return;
    // 세대를 올리지 않고 붙잡아 둔다 — 그사이 필터가 바뀌면 옛 필터의 다음 페이지를 새 목록에 붙이지 않는다
    const my = reqRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<{ devices: Device[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/devices?${query(next)}`
      );
      if (my !== reqRef.current) return;
      setDevices((cur) => [...(cur ?? []), ...d.devices]);
      setNext(d.next);
    } catch (e) {
      if (my !== reqRef.current) return;
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoadingMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = useNumberFormat();
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : "—");

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("devicesTitle")}
        description={t("devicesSubtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={checkTokens} disabled={checking}>
            <ShieldCheck aria-hidden="true" className="size-4" /> {checking ? t("checking") : t("checkTokens")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
          label={t("statUnverified")}
          value={num(summary?.unverified)}
          accent={summary && summary.unverified > 0 ? "warning" : "default"}
          loading={!summary}
          hint={t("unverifiedHint")}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
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

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!devices && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {devices && devices.length === 0 && <EmptyState icon={Smartphone} title={t("noDevices")} />}
          {devices && devices.length > 0 && (
            <>
              <DataTable label={t("devicesTitle")} rowCount={devices.length + 1}>
              <TableHeader
                grid="xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_8rem_10rem]"
                columns={[
                  { label: t("colUser") },
                  { label: t("colToken") },
                  { label: t("colPlatform") },
                  { label: t("colVersion") },
                  { label: t("colLastActive"), align: "end" },
                ]}
              />
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_8rem_10rem] xl:items-center">
                    <TableCell label={t("colUser")} className="truncate text-sm font-semibold">{d.externalId ?? <span className="font-normal text-muted-foreground">{t("anonymousDevice")}</span>}</TableCell>
                    <TableCell label={t("colToken")} className="truncate font-mono text-xs text-muted-foreground">{d.tokenPreview}</TableCell>
                    <TableCell label={t("colPlatform")}><Badge variant="neutral">{d.platform}</Badge></TableCell>
                    <TableCell label={t("colVersion")} className={FIELD_HINT_TEXT}>
                      {[d.appVersion, d.osVersion].filter(Boolean).join(" · ") || "—"}
                    </TableCell>
                    <TableCell label={t("colLastActive")} className="flex items-center justify-between gap-2 xl:justify-end">
                      <time dateTime={d.lastActiveAt ?? undefined} className="text-xs tabular-nums text-muted-foreground">
                        {d.lastActiveAt ? df.format(new Date(d.lastActiveAt)) : "—"}
                      </time>
                      {!d.verifiedAt && d.isActive && <Badge variant="warning">{t("badgeUnverified")}</Badge>}
                      <Badge variant={d.isActive ? "success" : "danger"}>
                        {d.isActive ? t("statActive") : t("statInactive")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {next && (
                <div className="flex justify-center border-t border-border p-3">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? tc("loading") : tc("loadMore")}
                  </Button>
                </div>
              )}
              </DataTable>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
