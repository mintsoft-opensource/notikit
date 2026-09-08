"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type SendType = "single" | "broadcast" | "topic" | "segment";

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
  const [sending, setSending] = React.useState(false);

  const needsTarget = type !== "broadcast";

  async function submit() {
    if (!sel) return toast.error(t("errSelectProject"));
    if (!title || !body) return toast.error(t("errTitleBody"));
    if (needsTarget && !target) return toast.error(t("errTarget"));
    if (sending) return;

    setSending(true);
    try {
      const payload: Record<string, unknown> = { title, body, type };
      if (needsTarget) payload.target = target;
      if (deepLink) payload.deep_link = deepLink;

      await adminApi(`/api/admin/projects/${sel}/messages`, { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("sendFailed"));
      setSending(false);
      return;
    }

    toast.success(t("queued"));
    setTitle("");
    setBody("");

    // 큐잉은 이미 성공 — 즉시 처리 실패를 "발송 실패"로 오인시키지 않도록 별도 처리
    if (processNow) {
      try {
        await adminApi(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
        toast.success(t("processed"));
      } catch (e) {
        toast.error(t("queuedProcessFailed", { error: e instanceof Error ? e.message : t("checkLogs") }));
      }
    }
    setSending(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("compose")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!projectId && (
            <div className="space-y-1">
              <Label>{t("project")}</Label>
              <ProjectPicker projects={projects} value={picked} onChange={setPicked} />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t("sendType")}</Label>
              <Select aria-label={t("sendType")} value={type} onChange={(e) => setType(e.target.value as SendType)}>
                <option value="single">{t("typeSingle")}</option>
                <option value="topic">{t("typeTopic")}</option>
                <option value="segment">{t("typeSegment")}</option>
                <option value="broadcast">{t("typeBroadcast")}</option>
              </Select>
            </div>
            <Field label={type === "single" ? "external_id" : type === "broadcast" ? t("targetUnneeded") : t("targetNameOf", { type })}>
              <Input spellCheck={false} autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!needsTarget} placeholder={needsTarget ? t("targetPlaceholder") : t("broadcastAll")} />
            </Field>
          </div>

          <Field label={t("titleLabel")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder={t("titlePlaceholder")} />
          </Field>
          <Field label={t("bodyLabel")}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={t("bodyPlaceholder")} />
          </Field>
          <Field label={t("deepLink")}>
            <Input inputMode="url" spellCheck={false} autoComplete="off" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path · https://…" />
          </Field>

          <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={processNow} onChange={(e) => setProcessNow(e.target.checked)} className="h-4 w-4 rounded-sm border-border accent-[var(--primary)]" />
              {t("processNow")}
            </label>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button onClick={submit} disabled={sending}>
            <Send aria-hidden="true" className="h-4 w-4" /> {sending ? t("sending") : t("submit")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
