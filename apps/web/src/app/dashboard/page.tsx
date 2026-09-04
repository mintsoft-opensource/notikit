"use client";

import * as React from "react";
import { Bell, Plus, Send, Upload, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Project = { id: string; name: string; apiKey: string; environment: string };
type Log = { id: string; title: string; type: string; status: string; totalCount: number; successCount: number; createdAt: string };

function useAdminToken() {
  const [token, setToken] = React.useState("");
  React.useEffect(() => {
    setToken(localStorage.getItem("notikit_admin_token") ?? "e2e-admin-token");
  }, []);
  const save = (t: string) => {
    localStorage.setItem("notikit_admin_token", t);
    setToken(t);
  };
  return { token, save };
}

export default function Dashboard() {
  const { token, save } = useAdminToken();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sel, setSel] = React.useState<Project | null>(null);
  const [logs, setLogs] = React.useState<Log[]>([]);
  const [msg, setMsg] = React.useState<string>("");

  const admin = React.useCallback(() => ({ "x-admin-token": token, "content-type": "application/json" }), [token]);

  const loadProjects = React.useCallback(async () => {
    const r = await fetch("/api/admin/projects", { headers: { "x-admin-token": token } });
    const j = await r.json();
    if (j.success) setProjects(j.data.projects);
    else setMsg(j.error ?? "load failed");
  }, [token]);

  React.useEffect(() => {
    if (token) loadProjects();
  }, [token, loadProjects]);

  async function createProject() {
    const name = prompt("프로젝트 이름");
    if (!name) return;
    const r = await fetch("/api/admin/projects", { method: "POST", headers: admin(), body: JSON.stringify({ name }) });
    const j = await r.json();
    setMsg(j.success ? `생성됨 · api_secret(1회): ${j.data.api_secret}` : j.error);
    loadProjects();
  }

  async function loadLogs(p: Project) {
    setSel(p);
    const r = await fetch(`/api/admin/projects/${p.id}/logs`, { headers: { "x-admin-token": token } });
    const j = await r.json();
    if (j.success) setLogs(j.data.logs);
  }

  async function uploadFirebase(p: Project) {
    const raw = prompt("Firebase 서비스 계정 JSON 붙여넣기");
    if (!raw) return;
    let creds: unknown;
    try {
      creds = JSON.parse(raw);
    } catch {
      setMsg("JSON 파싱 실패");
      return;
    }
    const r = await fetch(`/api/admin/projects/${p.id}/firebase`, { method: "POST", headers: admin(), body: JSON.stringify({ credentials: creds }) });
    const j = await r.json();
    setMsg(j.success ? `Firebase 저장됨 (${j.data.firebase_project_id})` : j.error);
  }

  async function sendTest(p: Project) {
    const secret = prompt("api-secret (발송 전용)");
    if (!secret) return;
    const target = prompt("대상 external_id") ?? "";
    const r = await fetch("/api/v1/messages", {
      method: "POST",
      headers: { "api-key": p.apiKey, "api-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ title: "테스트", body: "대시보드 발송", type: "single", target }),
    });
    setMsg(`발송 ${r.status}`);
    await fetch(`/api/admin/projects/${p.id}/process-queue`, { method: "POST", headers: admin(), body: "{}" });
    loadLogs(p);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Bell className="h-4 w-4" /></span>
          <h1 className="text-xl font-bold">Notikit 대시보드</h1>
        </div>
        <Button onClick={createProject} size="sm"><Plus className="h-4 w-4" /> 프로젝트</Button>
      </header>

      <div className="mt-4 flex items-center gap-2">
        <input
          defaultValue={token}
          onBlur={(e) => save(e.target.value)}
          placeholder="admin token"
          className="w-72 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
        />
        <Button variant="ghost" size="sm" onClick={loadProjects}><RefreshCw className="h-4 w-4" /> 새로고침</Button>
      </div>
      {msg && <p className="mt-3 break-all rounded-md bg-surface-muted p-3 text-xs">{msg}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>프로젝트 ({projects.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {projects.length === 0 && <p className="text-sm text-muted-foreground">프로젝트 없음 — 우측 상단에서 생성</p>}
            {projects.map((p) => (
              <div key={p.id} className={`rounded-lg border p-3 ${sel?.id === p.id ? "border-primary" : "border-border"}`}>
                <div className="flex items-center justify-between">
                  <button className="text-sm font-medium hover:underline" onClick={() => loadLogs(p)}>{p.name}</button>
                  <span className="text-xs text-muted-foreground">{p.environment}</span>
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">{p.apiKey}</p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => uploadFirebase(p)}><Upload className="h-3 w-3" /> Firebase</Button>
                  <Button variant="outline" size="sm" onClick={() => sendTest(p)}><Send className="h-3 w-3" /> 발송</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{sel ? `${sel.name} 로그` : "로그"}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {!sel && <p className="text-sm text-muted-foreground">프로젝트를 선택하세요</p>}
            {sel && logs.length === 0 && <p className="text-sm text-muted-foreground">로그 없음</p>}
            {logs.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="truncate">{l.title} <span className="text-muted-foreground">· {l.type}</span></span>
                <span className={l.status === "completed" ? "text-success" : l.status === "failed" ? "text-error" : "text-muted-foreground"}>
                  {l.status} ({l.successCount}/{l.totalCount})
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
