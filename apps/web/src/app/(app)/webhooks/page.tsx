"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Copy, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Webhook = { id: string; url: string; events: string[]; isActive: boolean; createdAt: string };

export default function WebhooksPage() {
  const { projects } = useProjects();
  const [sel, setSel] = React.useState("");
  const [hooks, setHooks] = React.useState<Webhook[]>([]);
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState("");
  const [secret, setSecret] = React.useState<string | null>(null);
  const reqRef = React.useRef(0);

  const load = React.useCallback(
    async (id: string) => {
      if (!id) return;
      const my = ++reqRef.current;
      setHooks([]);
      setSecret(null); // 프로젝트 전환 시 이전 secret 노출 방지
      try {
        const d = await adminApi<{ webhooks: Webhook[] }>(`/api/admin/projects/${id}/webhooks`);
        if (my !== reqRef.current) return;
        setHooks(d.webhooks);
      } catch (e) {
        if (my === reqRef.current) toast.error(e instanceof Error ? e.message : "로드 실패");
      }
    },
    []
  );

  React.useEffect(() => {
    if (sel) load(sel);
  }, [sel, load]);

  async function create() {
    if (!sel || !url.trim()) return;
    const evts = events.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const d = await adminApi<{ secret: string }>(`/api/admin/projects/${sel}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), events: evts }),
      });
      setSecret(d.secret);
      setUrl("");
      setEvents("");
      toast.success("웹훅 등록됨");
      load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "등록 실패 (SSRF 차단 URL 여부 확인)");
    }
  }

  async function retry() {
    if (!sel) return;
    try {
      const d = await adminApi<{ retried: number }>(`/api/admin/projects/${sel}/webhooks/retry`, { method: "POST", body: "{}" });
      toast.success(`재시도 ${d.retried}건`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "재시도 실패");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="웹훅"
        description="HMAC 서명 이벤트 배송 · SSRF 방어"
        actions={
          <Button variant="outline" size="sm" onClick={retry} disabled={!sel}>
            <RotateCw className="h-4 w-4" /> 실패 재시도
          </Button>
        }
      />
      <ProjectPicker projects={projects} value={sel} onChange={setSel} />

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>웹훅 등록</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label>URL</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/notikit" />
              </div>
              <div className="space-y-1">
                <Label>이벤트 (쉼표 구분, 비우면 전체)</Label>
                <Input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="message.sent, message.failed" />
              </div>
              <Button onClick={create} disabled={!url.trim()}>
                <Plus className="h-4 w-4" /> 등록
              </Button>
              {secret && (
                <button
                  onClick={() => { navigator.clipboard?.writeText(secret); toast.success("secret 복사됨"); }}
                  className="flex w-full items-center justify-between gap-2 rounded-md bg-accent-soft px-3 py-2 text-left font-mono text-xs text-primary"
                >
                  <span className="truncate">secret(1회): {secret}</span> <Copy className="h-3.5 w-3.5 shrink-0" />
                </button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>등록된 웹훅 ({hooks.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {hooks.length === 0 && <p className="text-sm text-muted-foreground">없음</p>}
              {hooks.map((h) => (
                <div key={h.id} className="rounded-lg border border-border px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{h.url}</span>
                    <Badge variant={h.isActive ? "success" : "neutral"}>{h.isActive ? "active" : "inactive"}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.events.length === 0 ? (
                      <Badge variant="primary">all events</Badge>
                    ) : (
                      h.events.map((e) => <Badge key={e} variant="neutral">{e}</Badge>)
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
