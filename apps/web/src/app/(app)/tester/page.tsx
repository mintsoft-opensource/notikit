"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";

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

type CreateResponse = { data?: { project?: { apiKey?: string; id?: string }; api_secret?: string } };

export default function TesterPage() {
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
    const raw = await res.text(); // 본문은 1회만 읽는다
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* 비 JSON 응답은 원문 그대로 */
    }
    push(name, res.status, res.ok, body);
    return { status: res.status, body };
  }

  async function runFullFlow() {
    setSteps([]);
    setRunning(true);
    try {
      const admin = { "x-admin-token": adminToken };
      const create = await call(
        "/api/admin/projects",
        { method: "POST", headers: admin, body: JSON.stringify({ name: `tester-${Date.now()}` }) },
        "1. 프로젝트 생성 (admin)"
      );
      const b = create.body as CreateResponse;
      const apiKey = b?.data?.project?.apiKey;
      const apiSecret = b?.data?.api_secret;
      const projectId = b?.data?.project?.id;
      setKeys({ apiKey, apiSecret, projectId });
      if (!apiKey || !apiSecret) return;

      // Firebase 미설정 유지 → log-only 데모 (실제 발송 대신 로그 기록)
      const token = `tester-tok-${Date.now()}`;
      const hash = await hmacHex(apiSecret, externalId);
      const appAuth = { "api-key": apiKey };

      await call(
        "/api/v1/devices",
        { method: "POST", headers: appAuth, body: JSON.stringify({ token, platform: "web", external_id: externalId, identity_hash: hash }) },
        "2. 디바이스 등록 (App SDK)"
      );
      await call(
        "/api/v1/users/identify",
        { method: "POST", headers: appAuth, body: JSON.stringify({ external_id: externalId, identity_hash: hash, attributes: { plan: "pro" } }) },
        "3. 유저 식별"
      );
      await call(
        "/api/v1/topics/subscribe",
        { method: "POST", headers: appAuth, body: JSON.stringify({ topic: "news", token }) },
        "4. 토픽 구독"
      );
      await call(
        "/api/v1/messages",
        { method: "POST", headers: { "api-key": apiKey, "api-secret": apiSecret }, body: JSON.stringify({ title: "테스터", body: "안녕하세요", type: "single", target: externalId, deep_link: "https://app/orders/1" }) },
        "5. 푸시 발송 (큐잉)"
      );
      await call(
        `/api/admin/projects/${projectId}/process-queue`,
        { method: "POST", headers: admin, body: "{}" },
        "6. 큐 처리 (log-only 발송)"
      );
    } catch (e) {
      push("오류", 0, false, e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        title="API 테스터"
        description="전체 플로우(프로젝트→디바이스 등록→식별→구독→발송→큐 처리)를 브라우저에서 실행·검증. Firebase 미설정 log-only 모드."
      />

      <Card>
        <CardHeader><CardTitle>설정</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Admin Token">
            <Input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
          </Field>
          <Field label="External User ID">
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button onClick={runFullFlow} disabled={running} size="lg">
              {running ? "실행 중…" : "전체 플로우 실행"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {keys.apiKey && (
        <p className="break-all text-xs text-muted-foreground">
          발급된 api-key: <code>{keys.apiKey}</code>
        </p>
      )}

      <div className="space-y-3">
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
    </div>
  );
}
