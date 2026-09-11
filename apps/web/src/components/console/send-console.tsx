"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Send, Info, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { DataRow } from "@/components/ui/data-row";
import { useProjects, adminApi } from "@/lib/admin-client";

type SendType = "single" | "broadcast" | "topic" | "segment";

/** 발송 뒤 하단에 남기는 결과 — 토스트는 사라지므로 확인할 수 있게 화면에 붙여둔다 */
type SendResult = {
  status: "queued" | "scheduled" | "processed" | "processFailed" | "failed";
  messageId?: string;
  scheduledAt?: string | null;
  error?: string;
};

/** 발송 콘솔 — projectId 고정(프로젝트 상세) 또는 피커(글로벌). admin 세션으로 발송(api-secret 불필요). */
export function SendConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("send");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [type, setType] = React.useState<SendType>("single");
  const [target, setTarget] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [deepLink, setDeepLink] = React.useState("");
  const [processNow, setProcessNow] = React.useState(true);
  const [scheduleAt, setScheduleAt] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<SendResult | null>(null);

  const needsTarget = type !== "broadcast";
  // 예약이면 지금 큐를 돌릴 이유가 없다 — 예약 시각에 워커가 처리한다
  const isScheduled = scheduleAt.trim().length > 0;

  async function submit() {
    if (!sel) return toast.error(t("errSelectProject"));
    if (!title || !body) return toast.error(t("errTitleBody"));
    if (needsTarget && !target) return toast.error(t("errTarget"));
    if (sending) return;

    // datetime-local 은 타임존 없는 로컬 시각이라 그대로 보내면 서버가 UTC 로 읽는다.
    // Date 로 한 번 통과시켜 오프셋을 붙인 ISO 로 바꾼다.
    let scheduledIso: string | null = null;
    if (isScheduled) {
      const d = new Date(scheduleAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return toast.error(t("errSchedulePast"));
      scheduledIso = d.toISOString();
    }

    setSending(true);
    setResult(null);

    let messageId: string | undefined;
    try {
      const payload: Record<string, unknown> = { title, body, type };
      if (needsTarget) payload.target = target;
      if (deepLink) payload.deep_link = deepLink;
      if (scheduledIso) payload.scheduled_at = scheduledIso;

      const res = await adminApi<{ message?: { id?: string } }>(
        `/api/admin/projects/${sel}/messages`,
        { method: "POST", body: JSON.stringify(payload) }
      );
      messageId = res?.message?.id;
    } catch (e) {
      const error = e instanceof Error ? e.message : t("sendFailed");
      toast.error(error);
      setResult({ status: "failed", error });
      setSending(false);
      return;
    }

    toast.success(isScheduled ? t("resultScheduled") : t("queued"));
    setTitle("");
    setBody("");

    // 예약 건은 지금 처리하지 않는다. 즉시 처리하면 예약 시각을 무시하고 나간다.
    if (!processNow || isScheduled) {
      setResult({ status: isScheduled ? "scheduled" : "queued", messageId, scheduledAt: scheduledIso });
      setSending(false);
      return;
    }

    // 큐잉은 이미 성공 — 즉시 처리 실패를 "발송 실패"로 오인시키지 않도록 별도 처리
    try {
      await adminApi(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processed"));
      setResult({ status: "processed", messageId });
    } catch (e) {
      const error = e instanceof Error ? e.message : t("checkLogs");
      toast.error(t("queuedProcessFailed", { error }));
      setResult({ status: "processFailed", messageId, error });
    }
    setSending(false);
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("compose")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0 space-y-3 rounded-tile border border-border bg-surface-muted/30 p-3.5">
            {!projectId && (
              <div className="space-y-1 [&_select]:w-full">
                <Label>{t("project")}</Label>
                <ProjectPicker projects={projects} value={picked} onChange={setPicked} />
              </div>
            )}
            <Field label={t("sendType")}>
              <Select value={type} onChange={(e) => setType(e.target.value as SendType)}>
                <option value="single">{t("typeSingle")}</option>
                <option value="topic">{t("typeTopic")}</option>
                <option value="segment">{t("typeSegment")}</option>
                <option value="broadcast">{t("typeBroadcast")}</option>
              </Select>
            </Field>
            <Field label={type === "single" ? "external_id" : type === "broadcast" ? t("targetUnneeded") : t("targetNameOf", { type })}>
              <Input spellCheck={false} autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!needsTarget} placeholder={needsTarget ? t("targetPlaceholder") : t("broadcastAll")} />
            </Field>
            <Field label={t("deepLink")}>
              <Input inputMode="url" spellCheck={false} autoComplete="off" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path · https://…" />
            </Field>
            <Field label={t("scheduleLabel")} hint={t("scheduleHint")}>
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
            </Field>
            <div className="border-t border-border pt-3 text-sm">
              <label className="flex items-start gap-2 leading-relaxed">
                <input
                  type="checkbox"
                  checked={processNow && !isScheduled}
                  disabled={isScheduled}
                  onChange={(e) => setProcessNow(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
                />
                <span className={isScheduled ? "text-muted-foreground" : undefined}>
                  {isScheduled ? t("processNowDisabled") : t("processNow")}
                </span>
              </label>
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <Field label={t("titleLabel")}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder={t("titlePlaceholder")} />
            </Field>
            <Field label={t("bodyLabel")}>
              <Textarea className="min-h-40 lg:min-h-56" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={t("bodyPlaceholder")} />
            </Field>

            <div className="space-y-2 border-t border-border pt-3">
              <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                <Info aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" /> {t("helpTitle")}
              </p>
              <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                <li>{t("helpTypes")}</li>
                <li>{t("helpDeepLink")}</li>
                <li>{t("helpSuppression")}</li>
                <li>{t("helpLogOnly")}</li>
              </ul>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-end">
          <Button onClick={submit} disabled={sending}>
            <Send aria-hidden="true" className="h-4 w-4" /> {sending ? t("sending") : t("submit")}
          </Button>
        </CardFooter>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              {result.status === "failed" || result.status === "processFailed" ? (
                <AlertTriangle aria-hidden="true" className={`h-4 w-4 ${result.status === "failed" ? "text-danger" : "text-warning"}`} />
              ) : result.status === "scheduled" ? (
                <Clock aria-hidden="true" className="h-4 w-4 text-primary" />
              ) : (
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
              )}
              {t("resultTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* 토스트는 사라지지만 메시지 ID 는 로그 대조에 필요하다 — 화면에 남긴다 */}
            <dl className="space-y-2 [&_dd]:min-w-0 [&_dd]:break-all">
              <DataRow
                label={t("resultStatus")}
                value={
                  result.status === "failed" ? t("resultFailed")
                    : result.status === "processFailed" ? t("resultProcessFailed")
                    : result.status === "processed" ? t("resultProcessed")
                    : result.status === "scheduled" ? t("resultScheduled")
                    : t("resultQueued")
                }
                tone={
                  result.status === "failed" ? "danger"
                    : result.status === "processFailed" ? "warning"
                    : "default"
                }
              />
              {result.messageId && <DataRow label={t("resultMessageId")} value={result.messageId} mono />}
              {result.scheduledAt && (
                <DataRow label={t("resultScheduledAt")} value={new Date(result.scheduledAt).toLocaleString()} />
              )}
              {result.error && <DataRow label={t("sendFailed")} value={result.error} />}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
