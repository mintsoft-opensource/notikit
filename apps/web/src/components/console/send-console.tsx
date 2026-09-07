"use client";

import * as React from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type SendType = "single" | "broadcast" | "topic" | "segment";

/** 발송 콘솔 — projectId 고정(프로젝트 상세) 또는 피커(글로벌). admin 세션으로 발송(api-secret 불필요). */
export function SendConsole({ projectId }: { projectId?: string }) {
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
    if (!sel) return toast.error("프로젝트를 선택하세요");
    if (!title || !body) return toast.error("제목과 본문을 입력하세요");
    if (needsTarget && !target) return toast.error("대상(target)을 입력하세요");
    if (sending) return;

    setSending(true);
    try {
      const payload: Record<string, unknown> = { title, body, type };
      if (needsTarget) payload.target = target;
      if (deepLink) payload.deep_link = deepLink;

      await adminApi(`/api/admin/projects/${sel}/messages`, { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "발송 실패");
      setSending(false);
      return;
    }

    toast.success("큐잉됨");
    setTitle("");
    setBody("");

    // 큐잉은 이미 성공 — 즉시 처리 실패를 "발송 실패"로 오인시키지 않도록 별도 처리
    if (processNow) {
      try {
        await adminApi(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
        toast.success("큐 처리 완료 (로그 확인)");
      } catch (e) {
        toast.error(`큐잉은 완료됨 — 즉시 처리 실패: ${e instanceof Error ? e.message : "로그를 확인하세요"}`);
      }
    }
    setSending(false);
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader title="발송" description="개인 · 토픽 · 세그먼트 · 전체 발송. Firebase 미설정 시 log-only." />

      <Card>
        <CardHeader>
          <CardTitle>메시지 작성</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!projectId && (
            <div className="space-y-1">
              <Label>프로젝트</Label>
              <ProjectPicker projects={projects} value={picked} onChange={setPicked} />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>발송 타입</Label>
              <Select aria-label="발송 타입" value={type} onChange={(e) => setType(e.target.value as SendType)}>
                <option value="single">single (개인)</option>
                <option value="topic">topic (토픽)</option>
                <option value="segment">segment (세그먼트)</option>
                <option value="broadcast">broadcast (전체)</option>
              </Select>
            </div>
            <Field label={type === "single" ? "external_id" : type === "broadcast" ? "대상 (불필요)" : `${type} 이름`}>
              <Input spellCheck={false} autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!needsTarget} placeholder={needsTarget ? "대상" : "전체 발송"} />
            </Field>
          </div>

          <Field label="제목">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="알림 제목" />
          </Field>
          <Field label="본문">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="알림 본문" />
          </Field>
          <Field label="딥링크 (선택)">
            <Input inputMode="url" spellCheck={false} autoComplete="off" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path 또는 https://…" />
          </Field>

          <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={processNow} onChange={(e) => setProcessNow(e.target.checked)} className="h-4 w-4" />
              발송 즉시 큐 처리 (로그 생성)
            </label>
          </div>

          <Button onClick={submit} disabled={sending} className="w-full">
            <Send aria-hidden="true" className="h-4 w-4" /> {sending ? "발송 중…" : "발송"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
