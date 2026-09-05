"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Upload, MessageSquare, Copy, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi, type Project } from "@/lib/admin-client";

function ProjectConfig({ project }: { project: Project }) {
  const [open, setOpen] = React.useState(false);
  const [firebase, setFirebase] = React.useState("");
  const [kakao, setKakao] = React.useState({ provider_url: "", api_key: "", sender_key: "" });

  async function uploadFirebase() {
    let creds: unknown;
    try {
      creds = JSON.parse(firebase);
    } catch {
      toast.error("JSON 파싱 실패");
      return;
    }
    try {
      const d = await adminApi<{ firebase_project_id?: string }>(`/api/admin/projects/${project.id}/firebase`, {
        method: "POST",
        body: JSON.stringify({ credentials: creds }),
      });
      toast.success(`Firebase 저장됨${d.firebase_project_id ? ` (${d.firebase_project_id})` : ""}`);
      setFirebase("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "실패");
    }
  }

  async function uploadKakao() {
    try {
      await adminApi(`/api/admin/projects/${project.id}/kakao`, { method: "POST", body: JSON.stringify(kakao) });
      toast.success("카카오 설정 저장됨");
      setKakao({ provider_url: "", api_key: "", sender_key: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "실패");
    }
  }

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{project.name}</span>
            <Badge variant={project.environment === "production" ? "primary" : "neutral"}>{project.environment}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{project.apiKey}</p>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="grid gap-6 border-t border-border p-4 md:grid-cols-2">
          <div className="space-y-2">
            <Field label={<span className="flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" /> Firebase 서비스 계정 JSON</span>}>
              <Textarea
                value={firebase}
                onChange={(e) => setFirebase(e.target.value)}
                placeholder='{"type":"service_account","project_id":"…"}'
                className="min-h-28 font-mono text-xs"
              />
            </Field>
            <Button size="sm" variant="outline" onClick={uploadFirebase} disabled={!firebase.trim()}>
              업로드 · 암호화 저장
            </Button>
          </div>

          <div className="space-y-2">
            <Label>
              <span className="flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" /> 카카오 알림톡 설정</span>
            </Label>
            <Input value={kakao.provider_url} onChange={(e) => setKakao({ ...kakao, provider_url: e.target.value })} placeholder="provider_url (https://…)" />
            <Input value={kakao.api_key} onChange={(e) => setKakao({ ...kakao, api_key: e.target.value })} placeholder="api_key" />
            <Input value={kakao.sender_key} onChange={(e) => setKakao({ ...kakao, sender_key: e.target.value })} placeholder="sender_key" />
            <Button size="sm" variant="outline" onClick={uploadKakao} disabled={!kakao.provider_url || !kakao.api_key || !kakao.sender_key}>
              카카오 저장
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const { projects, reload } = useProjects();
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState("dev");
  const [secret, setSecret] = React.useState<{ key: string; secret: string } | null>(null);
  const [creating, setCreating] = React.useState(false);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const d = await adminApi<{ project: { apiKey: string }; api_secret: string }>("/api/admin/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), environment }),
      });
      setSecret({ key: d.project.apiKey, secret: d.api_secret });
      setName("");
      toast.success("프로젝트 생성됨");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "생성 실패");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="프로젝트" description="프로젝트 생성 · Firebase/카카오 자격증명 관리" />

      <Card>
        <CardHeader>
          <CardTitle>새 프로젝트</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-project-name">이름</Label>
            <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: my-app-prod" />
          </div>
          <div className="space-y-1">
            <Label>환경</Label>
            <Select aria-label="환경" value={environment} onChange={(e) => setEnvironment(e.target.value)} className="sm:w-40">
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </Select>
          </div>
          <Button onClick={create} disabled={creating || !name.trim()} className="shrink-0">
            <Plus className="h-4 w-4" /> 생성
          </Button>
        </CardContent>
      </Card>

      {secret && (
        <Card className="border-primary/40">
          <CardContent className="space-y-2 p-5">
            <p className="text-sm font-bold text-primary">api_secret 은 지금만 확인할 수 있습니다 — 안전한 곳에 저장하세요.</p>
            <div className="space-y-1 font-mono text-xs">
              <button
                className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-left"
                onClick={async () => { try { await navigator.clipboard.writeText(secret.key); toast.success("api_key 복사됨"); } catch { toast.error("복사 실패 — 수동으로 선택하세요"); } }}
              >
                <span className="truncate">api_key: {secret.key}</span> <Copy className="h-3.5 w-3.5 shrink-0" />
              </button>
              <button
                className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-left"
                onClick={async () => { try { await navigator.clipboard.writeText(secret.secret); toast.success("api_secret 복사됨"); } catch { toast.error("복사 실패 — 수동으로 선택하세요"); } }}
              >
                <span className="truncate">api_secret: {secret.secret}</span> <Copy className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>닫기</Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {projects.length === 0 && <p className="text-sm text-muted-foreground">프로젝트가 없습니다.</p>}
        {projects.map((p) => (
          <ProjectConfig key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}
