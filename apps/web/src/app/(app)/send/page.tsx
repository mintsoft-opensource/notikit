"use client";

import * as React from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type SendType = "single" | "broadcast" | "topic" | "segment";

export default function SendPage() {
  const { projects } = useProjects();
  const [sel, setSel] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [type, setType] = React.useState<SendType>("single");
  const [target, setTarget] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [deepLink, setDeepLink] = React.useState("");
  const [kakaoFallback, setKakaoFallback] = React.useState(false);
  const [processNow, setProcessNow] = React.useState(true);
  const [sending, setSending] = React.useState(false);

  const project = projects.find((p) => p.id === sel);
  const needsTarget = type !== "broadcast";

  async function submit() {
    if (!project) return toast.error("프로젝트를 선택하세요");
    if (!secret) return toast.error("api-secret 을 입력하세요 (발송 전용)");
    if (!title || !body) return toast.error("제목과 본문을 입력하세요");
    if (needsTarget && !target) return toast.error("대상(target)을 입력하세요");

    setSending(true);
    try {
      const payload: Record<string, unknown> = { title, body, type, kakao_fallback: kakaoFallback };
      if (needsTarget) payload.target = target;
      if (deepLink) payload.deep_link = deepLink;

      const res = await fetch("/api/v1/messages", {
        method: "POST",
        headers: { "api-key": project.apiKey, "api-secret": secret, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `발송 실패 (HTTP ${res.status})`);
      toast.success(`큐잉됨 (HTTP ${res.status})`);

      if (processNow) {
        await adminApi(`/api/admin/projects/${project.id}/process-queue`, { method: "POST", body: "{}" });
        toast.success("큐 처리 완료 (로그 확인)");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "발송 실패");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader title="발송" description="개인 · 토픽 · 세그먼트 · 전체 발송. Firebase 미설정 시 log-only." />

      <Card>
        <CardHeader>
          <CardTitle>메시지 작성</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>프로젝트</Label>
              <ProjectPicker projects={projects} value={sel} onChange={setSel} />
            </div>
            <div className="space-y-1">
              <Label>api-secret (발송 전용)</Label>
              <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="notikit_sec_…" type="password" />
            </div>
          </div>

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
            <div className="space-y-1">
              <Label>{type === "single" ? "external_id" : type === "broadcast" ? "대상 (불필요)" : `${type} 이름`}</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} disabled={!needsTarget} placeholder={needsTarget ? "대상" : "전체 발송"} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>제목</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="알림 제목" />
          </div>
          <div className="space-y-1">
            <Label>본문</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="알림 본문" />
          </div>
          <div className="space-y-1">
            <Label>딥링크 (선택)</Label>
            <Input value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path 또는 https://…" />
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={kakaoFallback} onChange={(e) => setKakaoFallback(e.target.checked)} className="h-4 w-4" />
              미도달 유저에게 카카오 알림톡 폴백
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={processNow} onChange={(e) => setProcessNow(e.target.checked)} className="h-4 w-4" />
              발송 즉시 큐 처리 (로그 생성)
            </label>
          </div>

          <Button onClick={submit} disabled={sending} className="w-full">
            <Send className="h-4 w-4" /> {sending ? "발송 중…" : "발송"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
