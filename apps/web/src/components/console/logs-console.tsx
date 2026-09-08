"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Play, ScrollText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Log = { id: string; title: string; type: string; status: string; totalCount: number; successCount: number; createdAt: string };

function statusVariant(s: string): "success" | "danger" | "neutral" | "primary" {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "scheduled") return "primary";
  return "neutral";
}

export function LogsConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [logs, setLogs] = React.useState<Log[]>([]);
  const [loading, setLoading] = React.useState(false);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return;
      const my = ++reqRef.current;
      setLoading(true);
      setLogs([]);
      try {
        const d = await adminApi<{ logs: Log[] }>(`/api/admin/projects/${id}/logs`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setLogs(d.logs);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : t("loadFailed"));
      } finally {
        if (my === reqRef.current) setLoading(false);
      }
    },
    [t]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
    else setLogs([]);
  }, [sel, load]);

  async function processQueue() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number; failed: number }>(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processResult", { processed: d.processed, failed: d.failed }));
      load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("processFailed"));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sel && load(sel)} disabled={!sel}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> {tc("refresh")}
            </Button>
            <Button size="sm" onClick={processQueue} disabled={!sel}>
              <Play aria-hidden="true" className="h-4 w-4" /> {t("processQueue")}
            </Button>
          </>
        }
      />

      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      <Card>
        <CardContent className="p-0">
          {!sel && <EmptyState icon={ScrollText} title={tc("selectProjectFirst")} />}
          {sel && loading && <div className="space-y-3 p-5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {sel && !loading && logs.length === 0 && <EmptyState icon={ScrollText} title={t("empty")} />}
          {logs.length > 0 && (
            <ul className="divide-y divide-border">
              {logs.map((l) => (
                <li key={l.id} className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,1fr)_7rem_13rem_4rem_7rem]">
                  <p className="truncate text-sm font-semibold" title={l.title}>{l.title}</p>
                  <span className="col-start-1 row-start-2 text-xs text-muted-foreground xl:col-start-auto xl:row-start-auto">{l.type}</span>
                  <time dateTime={l.createdAt} className="col-start-1 text-xs tabular-nums text-muted-foreground xl:col-start-auto xl:text-right">{df.format(new Date(l.createdAt))}</time>
                  <span className="col-start-2 row-start-2 text-right text-xs font-semibold tabular-nums text-muted-foreground xl:col-start-auto xl:row-start-auto">{l.successCount}/{l.totalCount}</span>
                  <div className="col-start-2 row-start-1 justify-self-end xl:col-start-5"><Badge variant={statusVariant(l.status)}>{l.status}</Badge></div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
