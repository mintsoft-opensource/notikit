"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Copy, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
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
  // 1회성 secret 은 프로젝트별로 보존 (전환해도 유실/혼선 없음)
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const secret = sel ? secrets[sel] ?? null : null;
  const [creating, setCreating] = React.useState(false);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return; // stale 호출(전환 후) 무시
      const my = ++reqRef.current;
      setHooks([]);
      try {
        const d = await adminApi<{ webhooks: Webhook[] }>(`/api/admin/projects/${id}/webhooks`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setHooks(d.webhooks);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : "로드 실패");
      }
    },
    []
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
  }, [sel, load]);

  async function create() {
    if (!sel || !url.trim() || creating) return; // 직렬화: 동시 제출 방지
    const target = sel;
    const evts = events.split(",").map((s) => s.trim()).filter(Boolean);
    setCreating(true);
    try {
      const d = await adminApi<{ secret: string }>(`/api/admin/projects/${target}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), events: evts }),
      });
      // secret 은 target 프로젝트에 귀속 보존 → 전환해도 유실 없고 타 프로젝트에 노출되지 않음
      setSecrets((s) => ({ ...s, [target]: d.secret }));
      toast.success("웹훅 등록됨");
      // 폼 초기화·목록 새로고침은 여전히 target 을 보고 있을 때만 (B 의 입력 보호)
      if (selRef.current === target) {
        setUrl("");
        setEvents("");
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "등록 실패 (SSRF 차단 URL 여부 확인)");
    } finally {
      setCreating(false);
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
              <Field label="URL">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/notikit" />
              </Field>
              <Field label="이벤트 (쉼표 구분, 비우면 전체)">
                <Input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="message.sent, message.failed" />
              </Field>
              <Button onClick={create} disabled={!url.trim() || creating}>
                <Plus className="h-4 w-4" /> {creating ? "등록 중…" : "등록"}
              </Button>
              {secret && (
                <button
                  onClick={async () => { try { await navigator.clipboard.writeText(secret); toast.success("secret 복사됨"); } catch { toast.error("복사 실패 — 수동으로 선택하세요"); } }}
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
