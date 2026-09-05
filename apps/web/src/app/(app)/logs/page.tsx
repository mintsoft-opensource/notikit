"use client";

import * as React from "react";
import { toast } from "sonner";
import { RefreshCw, Play } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker, TokenRequired } from "@/components/console/shared";
import { useAdminToken, useProjects, adminApi } from "@/lib/admin-client";

type Log = { id: string; title: string; type: string; status: string; totalCount: number; successCount: number; createdAt: string };

function statusVariant(s: string): "success" | "danger" | "neutral" | "primary" {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "scheduled") return "primary";
  return "neutral";
}

export default function LogsPage() {
  const { token, ready } = useAdminToken();
  const { projects } = useProjects(token, ready);
  const [sel, setSel] = React.useState("");
  const [logs, setLogs] = React.useState<Log[]>([]);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(
    async (id: string) => {
      if (!id) return;
      setLoading(true);
      try {
        const d = await adminApi<{ logs: Log[] }>(`/api/admin/projects/${id}/logs`, token);
        setLogs(d.logs);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "로드 실패");
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  React.useEffect(() => {
    if (sel) load(sel);
  }, [sel, load]);

  async function processQueue() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number; failed: number }>(`/api/admin/projects/${sel}/process-queue`, token, { method: "POST", body: "{}" });
      toast.success(`처리 ${d.processed} · 실패 ${d.failed}`);
      load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "처리 실패");
    }
  }

  if (ready && !token) {
    return (
      <div className="space-y-6">
        <PageHeader title="로그" />
        <TokenRequired />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="발송 로그"
        description="프로젝트별 발송 상태 · 성공/실패 집계"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sel && load(sel)} disabled={!sel}>
              <RefreshCw className="h-4 w-4" /> 새로고침
            </Button>
            <Button size="sm" onClick={processQueue} disabled={!sel}>
              <Play className="h-4 w-4" /> 큐 처리
            </Button>
          </>
        }
      />

      <ProjectPicker projects={projects} value={sel} onChange={setSel} />

      <Card>
        <CardContent className="p-0">
          {!sel && <p className="p-6 text-sm text-muted-foreground">프로젝트를 선택하세요.</p>}
          {sel && loading && <p className="p-6 text-sm text-muted-foreground">불러오는 중…</p>}
          {sel && !loading && logs.length === 0 && <p className="p-6 text-sm text-muted-foreground">로그가 없습니다.</p>}
          {logs.length > 0 && (
            <ul className="divide-y divide-border">
              {logs.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.type} · {new Date(l.createdAt).toLocaleString("ko-KR")}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {l.successCount}/{l.totalCount}
                    </span>
                    <Badge variant={statusVariant(l.status)}>{l.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
