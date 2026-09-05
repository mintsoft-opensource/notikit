"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus, Copy, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi } from "@/lib/admin-client";

export default function ProjectsPage() {
  const { projects, reload } = useProjects();
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState("dev");
  const [secret, setSecret] = React.useState<{ key: string; secret: string } | null>(null);
  const [creating, setCreating] = React.useState(false);

  async function create() {
    if (!name.trim() || creating) return;
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
    <div className="w-full space-y-6">
      <PageHeader title="프로젝트" description="프로젝트 생성 · 상세에서 발송/로그/설정 관리" />

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
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface-muted"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{p.name}</span>
                <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
                {p.hasFirebase ? <Badge variant="success">Firebase</Badge> : <Badge variant="neutral">log-only</Badge>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{p.apiKey}</p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}
