"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Download, LifeBuoy, Package, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataRow } from "@/components/console/panels";
import { adminApi } from "@/lib/admin-client";

type Job = {
  id: string;
  fromVersion: string;
  targetVersion: string;
  status: "pending" | "running" | "succeeded" | "failed";
  step: string | null;
  log: string;
  backupPath: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

type LicenseInfo = {
  status: "valid" | "expired" | "invalid" | "missing";
  reason?: string;
  customerName?: string;
  expiresAt?: string;
  daysRemaining?: number;
  channel?: string;
  limits?: { projects?: number; devices?: number; sendsPerMonth?: number };
  expiringSoon?: boolean;
};

type Bundle = {
  file: string;
  version: string;
  digest: string;
  sizeBytes: number;
  createdAt: string | null;
  verifiable: boolean;
};

type Status = {
  current: string;
  license: LicenseInfo;
  bundles: Bundle[];
  latest: { version: string; notes: string; hasMigrations: boolean; publishedAt: string | null } | null;
  status: "ok" | "unconfigured" | "unlicensed" | "unreachable";
  outdated: boolean;
  blockedBy: string | null;
  canUpdate: boolean;
  active: Job | null;
  history: Job[];
};

/** 진행 중일 때는 자주, 평소에는 드물게 */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 60_000;

export function UpdatePanel() {
  const t = useTranslations("update");
  const [data, setData] = React.useState<Status | null>(null);
  const [starting, setStarting] = React.useState(false);
  /**
   * 업데이트는 이 화면을 서빙하는 컨테이너를 재시작시킨다. 그동안 조회는 실패한다 —
   * 그것을 오류로 보여 주면 "업데이트가 깨졌다"로 읽힌다. 진행 중이었다면
   * 재시작으로 간주하고 계속 두드린다.
   */
  const [unreachable, setUnreachable] = React.useState(false);
  /**
   * 폴링 주기를 정할 때 읽는다. state 로 읽으면 주기를 바꾸려 effect 를 다시 돌려야
   * 하고, 그 사이 한 박자가 비어 진행 중인 업데이트가 멈춘 것처럼 보인다.
   */
  const busyRef = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const res = await adminApi<Status>("/api/admin/update");
      setData(res);
      setUnreachable(false);
      busyRef.current = !!res.active;
    } catch {
      // 진행 중이 아니었다면 진짜 오류다. 진행 중이었다면 재시작이다.
      if (busyRef.current) setUnreachable(true);
    }
  }, []);

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      await load();
      if (stopped) return;
      timer = setTimeout(tick, busyRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  const active = data?.active ?? null;
  const busy = !!active || unreachable;

  async function install(payload: { target_version: string; bundle?: string }) {
    if (!confirm(t("confirm"))) return;
    setStarting(true);
    try {
      await adminApi("/api/admin/update", { method: "POST", body: JSON.stringify(payload) });
      busyRef.current = true;
      await load();
    } finally {
      setStarting(false);
    }
  }

  if (!data && !unreachable) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">…</CardContent></Card>;
  }

  return (
    <div className="w-full space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <DataRow label={t("current")} value={data?.current ?? "—"} />
          {data?.latest && <DataRow label={t("latest")} value={data.latest.version} />}

          {unreachable && (
            <Notice tone="info" icon={<RefreshCw className="h-4 w-4 animate-spin" />}>
              {t("restarting")}
            </Notice>
          )}

          {!unreachable && data?.status === "unconfigured" && <Notice tone="muted">{t("unconfigured")}</Notice>}
          {!unreachable && data?.status === "unlicensed" && <Notice tone="warn">{t("unlicensed")}</Notice>}
          {!unreachable && data?.status === "unreachable" && <Notice tone="warn">{t("unreachable")}</Notice>}

          {!busy && data?.status === "ok" && !data.outdated && (
            <Notice tone="ok" icon={<CheckCircle2 className="h-4 w-4" />}>{t("upToDate")}</Notice>
          )}

          {!busy && data?.outdated && (
            <div className="space-y-3">
              <Notice tone="info">{t("available")}</Notice>
              {/* 스키마가 바뀌면 되돌리기가 백업 복원뿐이다. 누르기 전에 알아야 한다. */}
              {data.latest?.hasMigrations && (
                <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>{t("hasMigrations")}</Notice>
              )}
              {data.blockedBy && (
                <Notice tone="warn">{t("blocked", { version: data.blockedBy })}</Notice>
              )}
              {data.canUpdate ? (
                <Button
                  onClick={() => install({ target_version: data.latest!.version })}
                  disabled={starting || !!data.blockedBy}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  {starting ? t("installing") : t("install")}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">{t("operatorOnly")}</p>
              )}
            </div>
          )}

          {active && <Progress job={active} t={t} />}
        </CardContent>
      </Card>

      {data?.latest?.notes && (
        <Card>
          <CardHeader><CardTitle>{t("notes")}</CardTitle></CardHeader>
          <CardContent>
            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-muted-foreground">{data.latest.notes}</pre>
          </CardContent>
        </Card>
      )}

      {data?.license && <LicenseCard info={data.license} t={t} />}

      {/* 반입된 번들이 있을 때만 보인다 — 폐쇄망이 아닌 설치에는 없는 개념이다 */}
      {(data?.bundles?.length ?? 0) > 0 && (
        <BundleCard
          bundles={data!.bundles}
          current={data!.current}
          canUpdate={data!.canUpdate}
          disabled={starting || busy}
          onInstall={(b) => install({ target_version: b.version, bundle: b.file })}
          t={t}
        />
      )}

      <History jobs={data?.history ?? []} t={t} />

      <Card>
        <CardHeader><CardTitle>{t("supportBundle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("supportBundleHint")}</p>
          <Button asChild variant="secondary">
            <a href="/api/admin/support-bundle" download>
              <LifeBuoy className="mr-1.5 h-4 w-4" />
              {t("downloadSupportBundle")}
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function LicenseCard({ info, t }: { info: LicenseInfo; t: ReturnType<typeof useTranslations> }) {
  return (
    <Card>
      <CardHeader><CardTitle>{t("license")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {info.status === "valid" && !info.expiringSoon && (
          <Notice tone="ok" icon={<CheckCircle2 className="h-4 w-4" />}>{t("licenseValid")}</Notice>
        )}
        {/* 만료가 곧 정지가 아니라는 점을 문구로 분명히 한다 */}
        {info.status === "expired" && <Notice tone="warn">{t("licenseExpired")}</Notice>}
        {info.status === "invalid" && <Notice tone="warn">{t("licenseInvalid")}{info.reason ? ` — ${info.reason}` : ""}</Notice>}
        {info.status === "missing" && <Notice tone="muted">{t("licenseMissing")}</Notice>}
        {info.expiringSoon && (
          <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
            {t("licenseExpiringSoon", { days: info.daysRemaining ?? 0 })}
          </Notice>
        )}

        {info.customerName && <DataRow label={t("customer")} value={info.customerName} />}
        {info.expiresAt && <DataRow label={t("expiresAt")} value={new Date(info.expiresAt).toLocaleDateString()} />}
        {info.channel && <DataRow label={t("channel")} value={info.channel} />}
        {info.limits?.projects != null && <DataRow label={t("limitProjects")} value={info.limits.projects.toLocaleString()} />}
        {info.limits?.devices != null && <DataRow label={t("limitDevices")} value={info.limits.devices.toLocaleString()} />}
        {info.limits?.sendsPerMonth != null && <DataRow label={t("limitSends")} value={info.limits.sendsPerMonth.toLocaleString()} />}
      </CardContent>
    </Card>
  );
}

function BundleCard({
  bundles, current, canUpdate, disabled, onInstall, t,
}: {
  bundles: Bundle[];
  current: string;
  canUpdate: boolean;
  disabled: boolean;
  onInstall: (b: Bundle) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>{t("airgap")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("airgapHint")}</p>
        <ul className="space-y-3">
          {bundles.map((b) => (
            <li key={b.file} className="space-y-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <Package className="h-4 w-4 text-muted-foreground" />
                {b.version}
                <span className="font-normal text-muted-foreground">
                  {(b.sizeBytes / 1_073_741_824).toFixed(2)} GB
                </span>
              </div>
              <p className="font-mono text-2xs text-muted-foreground">{b.file}</p>
              {/* 검증할 수 없는 번들은 무엇을 설치하는지 모르는 것과 같다 */}
              {!b.verifiable ? (
                <Notice tone="warn">{t("airgapUnverifiable")}</Notice>
              ) : (
                canUpdate && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={disabled || b.version === current}
                    onClick={() => onInstall(b)}
                  >
                    {t("installFromBundle")}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
        {bundles.length === 0 && <p className="text-sm text-muted-foreground">{t("airgapNone")}</p>}
      </CardContent>
    </Card>
  );
}

function Progress({ job, t }: { job: Job; t: ReturnType<typeof useTranslations> }) {
  const stepLabel = job.step ? t(`steps.${job.step}` as never) : t(`status.${job.status}` as never);
  return (
    <div className="space-y-2 border border-border bg-surface-muted p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {job.fromVersion} → {job.targetVersion} · {stepLabel}
      </div>
      {job.log && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground">{job.log}</pre>
      )}
    </div>
  );
}

function History({ jobs, t }: { jobs: Job[]; t: ReturnType<typeof useTranslations> }) {
  const done = jobs.filter((j) => j.status === "succeeded" || j.status === "failed");
  return (
    <Card>
      <CardHeader><CardTitle>{t("history")}</CardTitle></CardHeader>
      <CardContent>
        {done.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
        ) : (
          <ul className="space-y-3">
            {done.map((j) => (
              <li key={j.id} className="space-y-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {j.status === "succeeded" ? (
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  {j.fromVersion} → {j.targetVersion}
                  <span className="font-normal text-muted-foreground">
                    {new Date(j.finishedAt ?? j.createdAt).toLocaleString()}
                  </span>
                </div>
                {j.error && <p className="text-sm text-destructive">{j.error}</p>}
                {/* 실패했을 때 되돌릴 수 있는 유일한 자산이다. 숨기면 안 된다. */}
                {j.backupPath && (
                  <p className="font-mono text-2xs text-muted-foreground">
                    {t("backupAt")}: {j.backupPath}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Notice({
  children,
  tone,
  icon,
}: {
  children: React.ReactNode;
  tone: "ok" | "warn" | "info" | "muted";
  icon?: React.ReactNode;
}) {
  const styles = {
    ok: "border-primary/30 bg-accent-soft text-foreground",
    warn: "border-destructive/30 bg-destructive/5 text-foreground",
    info: "border-border bg-surface-muted text-foreground",
    muted: "border-border bg-surface text-muted-foreground",
  }[tone];
  return (
    <div className={`flex items-start gap-2 border p-3 text-sm ${styles}`}>
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
