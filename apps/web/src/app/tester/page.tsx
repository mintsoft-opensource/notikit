"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Step = { name: string; status: number; ok: boolean; res: unknown };

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DEMO_SA = {
  type: "service_account",
  project_id: "demo-proj",
  private_key: "-----BEGIN PRIVATE KEY-----\\nDEMO\\n-----END PRIVATE KEY-----\\n",
  client_email: "sdk@demo-proj.iam.gserviceaccount.com",
};

export default function Tester() {
  const [adminToken, setAdminToken] = React.useState("e2e-admin-token");
  const [externalId, setExternalId] = React.useState("tester-user-1");
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [running, setRunning] = React.useState(false);
  const [keys, setKeys] = React.useState<{ apiKey?: string; apiSecret?: string; projectId?: string }>({});

  function push(name: string, status: number, ok: boolean, res: unknown) {
    setSteps((s) => [...s, { name, status, ok, res }]);
  }

  async function call(path: string, opts: RequestInit, name: string) {
    const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    push(name, res.status, res.ok, body);
    return { status: res.status, body };
  }

  async function runFullFlow() {
    setSteps([]);
    setRunning(true);
    try {
      // 1) 프로젝트 생성 (admin)
      const admin = { "x-admin-token": adminToken };
      const create = await call(
        "/api/admin/projects",
        { method: "POST", headers: admin, body: JSON.stringify({ name: `tester-${Date.now()}` }) },
        "1. 프로젝트 생성 (admin)"
      );
      const apiKey = (create.body as any)?.data?.project?.apiKey;
      const apiSecret = (create.body as any)?.data?.api_secret;
      const projectId = (create.body as any)?.data?.project?.id;
      setKeys({ apiKey, apiSecret, projectId });
      if (!apiKey || !apiSecret) return;

      // 2) Firebase 업로드 (log-only 데모)
      await call(
        `/api/admin/projects/${projectId}/firebase`,
        { method: "POST", headers: admin, body: JSON.stringify({ credentials: DEMO_SA }) },
        "2. Firebase 크레덴셜 업로드"
      );

      const token = `tester-tok-${Date.now()}`;
      const hash = await hmacHex(apiSecret, externalId);
      const appAuth = { "api-key": apiKey };

      // 3) 디바이스 등록 (public + identity_hash)
      await call(
        "/api/v1/devices",
        { method: "POST", headers: appAuth, body: JSON.stringify({ token, platform: "web", external_id: externalId, identity_hash: hash }) },
        "3. 디바이스 등록 (App SDK)"
      );

      // 4) 유저 식별
      await call(
        "/api/v1/users/identify",
        { method: "POST", headers: appAuth, body: JSON.stringify({ external_id: externalId, identity_hash: hash, attributes: { plan: "pro" } }) },
        "4. 유저 식별"
      );

      // 5) 토픽 구독
      await call(
        "/api/v1/topics/subscribe",
        { method: "POST", headers: appAuth, body: JSON.stringify({ topic: "news", token }) },
        "5. 토픽 구독"
      );

      // 6) 발송 (privileged: secret)
      await call(
        "/api/v1/messages",
        { method: "POST", headers: { "api-key": apiKey, "api-secret": apiSecret }, body: JSON.stringify({ title: "테스터", body: "안녕하세요", type: "single", target: externalId, deep_link: "https://app/orders/1" }) },
        "6. 푸시 발송 (큐잉)"
      );

      // 7) 큐 처리 (log-only 발송)
      await call(
        `/api/admin/projects/${projectId}/process-queue`,
        { method: "POST", headers: admin, body: "{}" },
        "7. 큐 처리 (실발송/log-only)"
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Notikit API 테스터</h1>
      <p className="mt-1 text-sm text-muted-foreground">전체 플로우(프로젝트→Firebase→등록→식별→구독→발송→처리)를 브라우저에서 실행·검증</p>

      <Card className="mt-6">
        <CardHeader><CardTitle>설정</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted-foreground">Admin Token</span>
            <input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">External User ID</span>
            <input value={externalId} onChange={(e) => setExternalId(e.target.value)} className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-2" />
          </label>
          <div className="sm:col-span-2">
            <Button onClick={runFullFlow} disabled={running} size="lg">
              {running ? "실행 중…" : "전체 플로우 실행"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {keys.apiKey && (
        <p className="mt-4 break-all text-xs text-muted-foreground">
          발급된 api-key: <code>{keys.apiKey}</code>
        </p>
      )}

      <div className="mt-6 space-y-3">
        {steps.map((s, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.name}</span>
                <span className={s.ok ? "text-success" : "text-error"}>HTTP {s.status} {s.ok ? "✓" : "✗"}</span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md bg-surface-muted p-3 text-xs">{JSON.stringify(s.res, null, 2)}</pre>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
