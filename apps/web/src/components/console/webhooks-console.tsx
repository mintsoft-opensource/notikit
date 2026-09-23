"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Copy, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { WebhookDeliveries } from "@/components/console/webhook-deliveries";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";

type Webhook = { id: string; url: string; events: string[]; isActive: boolean; createdAt: string };

export function WebhooksConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("webhooks");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  /** null = 불러오는 중. 빈 배열로 시작하면 로딩 중에 "없음"이 먼저 보인다 */
  const [hooks, setHooks] = React.useState<Webhook[] | null>(null);
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState("");
  // 1회성 secret 은 프로젝트별로 보존 (전환해도 유실/혼선 없음)
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const secret = sel ? secrets[sel] ?? null : null;
  const [creating, setCreating] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return; // stale 호출(전환 후) 무시
      const my = ++reqRef.current;
      setHooks(null);
      try {
        const d = await adminApi<{ webhooks: Webhook[] }>(`/api/admin/projects/${id}/webhooks`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setHooks(d.webhooks);
      } catch (e) {
        if (my !== reqRef.current || id !== selRef.current) return;
        // 실패해도 스켈레톤을 계속 돌리지 않는다 — 토스트로 알리고 빈 목록으로 둔다
        setHooks([]);
        toast.error(errorText(e, tc("loadFailed")));
      }
    },
    [tc]
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
      toast.success(t("registered"));
      // 폼 초기화·목록 새로고침은 여전히 target 을 보고 있을 때만 (B 의 입력 보호)
      if (selRef.current === target) {
        setUrl("");
        setEvents("");
        load(target);
      }
    } catch (e) {
      toast.error(errorText(e, t("registerFailed")));
    } finally {
      setCreating(false);
    }
  }

  async function retry() {
    // 재시도는 실패 건을 다시 큐에 넣는다 — 두 번 누르면 같은 이벤트가 두 번 나갈 수 있다
    if (!sel || retrying) return;
    setRetrying(true);
    try {
      const d = await adminApi<{ retried: number }>(`/api/admin/projects/${sel}/webhooks/retry`, { method: "POST", body: "{}" });
      toast.success(t("retried", { count: d.retried }));
    } catch (e) {
      toast.error(errorText(e, t("retryFailed")));
    } finally {
      setRetrying(false);
    }
  }

  async function copySecret(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("secretCopied"));
    } catch {
      toast.error(t("copyFailedManual"));
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={retry} disabled={!sel || retrying}>
            <RotateCw aria-hidden="true" className="h-4 w-4" /> {t("retryFailedBtn")}
          </Button>
        }
      />
      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>{t("register")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {/* 넓은 화면은 입력 두 칸과 등록 버튼을 한 줄에 — 버튼은 입력칸 바닥선(items-end)에 맞춘다 */}
              <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_auto] md:items-end">
                <Field label="URL">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/notikit" />
                </Field>
                <Field label={t("eventsLabel")}>
                  <Input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="message.sent, message.failed" />
                </Field>
                <Button onClick={create} disabled={!url.trim() || creating} className="justify-self-end md:justify-self-auto">
                  <Plus aria-hidden="true" className="h-4 w-4" /> {creating ? t("registering") : t("registerBtn")}
                </Button>
              </div>
              {secret && (
                // 값은 글자로 보이고, 복사는 공용 Button 이 맡는다 — 포커스 링·크기 규칙을 따르게
                <div className="flex items-center justify-between gap-3 rounded-lg bg-accent-soft py-1.5 ps-3 pe-1.5">
                  <span className="min-w-0 truncate font-mono text-xs text-primary">{t("secretOnce")}: {secret}</span>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => copySecret(secret)}>
                    <Copy aria-hidden="true" className="h-4 w-4" /> {tc("copy")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("listTitle", { count: hooks?.length ?? 0 })}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {!hooks && <><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></>}
              {hooks?.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
              {hooks?.map((h) => (
                <div key={h.id} className="rounded-lg border border-border px-3.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{h.url}</span>
                    <Badge variant={h.isActive ? "success" : "neutral"}>{h.isActive ? t("statusActive") : t("statusInactive")}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.events.length === 0 ? (
                      <Badge variant="primary">{t("allEvents")}</Badge>
                    ) : (
                      h.events.map((e) => <Badge key={e} variant="neutral">{e}</Badge>)
                    )}
                  </div>
                  <WebhookDeliveries projectId={sel} webhookId={h.id} />
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
