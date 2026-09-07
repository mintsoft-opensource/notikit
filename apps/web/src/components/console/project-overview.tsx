"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Send, ScrollText, Settings, ArrowRight, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Stats = {
  devices: { total: number; active: number; dau: number };
  users: { total: number };
  messages: { total_sends: number; total_delivered: number };
};

const LINKS = (id: string) => [
  { href: `/projects/${id}/send`, labelKey: "linkSend", icon: Send, descKey: "linkSendDesc" },
  { href: `/projects/${id}/logs`, labelKey: "linkLogs", icon: ScrollText, descKey: "linkLogsDesc" },
  { href: `/projects/${id}/settings`, labelKey: "linkSettings", icon: Settings, descKey: "linkSettingsDesc" },
] as const;

export function ProjectOverview({ projectId }: { projectId: string }) {
  const t = useTranslations("overview");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [statsError, setStatsError] = React.useState(false);
  const [statsRetry, setStatsRetry] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setStats(null);
    setStatsError(false);
    adminApi<Stats>(`/api/admin/projects/${projectId}/stats`)
      .then((d) => alive && setStats(d))
      .catch(() => alive && setStatsError(true));
    return () => {
      alive = false;
    };
  }, [projectId, statsRetry]);

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const num = (v: number | undefined) => (typeof v === "number" ? nf.format(v) : statsError ? "—" : "…");

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title={project?.name ?? t("projectFallback")}
        description={t("subtitle")}
        actions={project ? <Badge variant={project.environment === "production" ? "primary" : "neutral"}>{project.environment}</Badge> : undefined}
      />

      {project && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted-foreground">api-key</p>
              <p className="truncate font-mono text-sm">{project.apiKey}</p>
            </div>
            <div className="flex items-center gap-2">
              {project.hasFirebase ? <Badge variant="success">{t("firebaseConfigured")}</Badge> : <Badge variant="neutral">log-only</Badge>}
              <button
                type="button"
                onClick={async () => { try { await navigator.clipboard.writeText(project.apiKey); toast.success(t("apiKeyCopied")); } catch { toast.error(tc("copyFailed")); } }}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-muted"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" /> {tc("copy")}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {statsError && (
        <div role="status" aria-live="polite" className="flex items-center justify-between rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-muted-foreground">
          <span>{t("statsLoadFailed")}</span>
          <button
            type="button"
            onClick={() => setStatsRetry((n) => n + 1)}
            className="rounded-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {tc("retry")}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("statDevices")} value={num(stats?.devices.total)} />
        <StatCard label={t("statUsers")} value={num(stats?.users.total)} />
        <StatCard label={t("statSends")} value={num(stats?.messages.total_sends)} />
        <StatCard label={t("statActiveDevices")} value={num(stats?.devices.active)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {LINKS(projectId).map((l) => {
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href}>
              <Card className="group transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-3 p-5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-primary">
                    <Icon aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-bold">{t(l.labelKey)}</p>
                    <p className="text-xs text-muted-foreground">{t(l.descKey)}</p>
                  </div>
                  <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
