"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("tester");
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
        t("stepCreateProject")
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
        { method: "POST", headers: appAuth, body: JSON.stringify({ token, platform: "web", user_id: externalId, identity_hash: hash }) },
        t("stepRegisterDevice")
      );
      await call(
        "/api/v1/users/identify",
        { method: "POST", headers: appAuth, body: JSON.stringify({ user_id: externalId, identity_hash: hash, attributes: { plan: "pro" } }) },
        t("stepIdentify")
      );
      await call(
        "/api/v1/topics/subscribe",
        { method: "POST", headers: appAuth, body: JSON.stringify({ topic: "news", token }) },
        t("stepSubscribe")
      );
      /*
       * 서버용 api-secret 을 브라우저에서 쓰는 곳은 여기뿐이다. 이 화면은 관리자 QA 전용
       * (관리자 토큰으로 방금 만든 일회용 프로젝트의 키)이라 허용한다 — 실제 고객 앱은
       * api-secret 을 절대 클라이언트에 두지 않고 서버에서만 발송 API 를 호출해야 한다.
       */
      await call(
        "/api/v1/messages",
        { method: "POST", headers: { "api-key": apiKey, "api-secret": apiSecret }, body: JSON.stringify({ title: t("sampleTitle"), body: t("sampleBody"), type: "single", target: externalId, deep_link: "https://app/orders/1" }) },
        t("stepSend")
      );
      await call(
        `/api/admin/projects/${projectId}/process-queue`,
        { method: "POST", headers: admin, body: "{}" },
        t("stepProcessQueue")
      );
    } catch (e) {
      push(t("stepError"), 0, false, e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
      />

      <Card>
        <CardHeader><CardTitle>{t("settings")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={t("adminToken")}>
            <Input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
          </Field>
          <Field label={t("externalId")}>
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button onClick={runFullFlow} disabled={running}>
              {running ? t("running") : t("run")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {keys.apiKey && (
        <p className="break-all text-xs text-muted-foreground">
          {t("issuedApiKey")} <code>{keys.apiKey}</code>
        </p>
      )}

      <div className="space-y-4">
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
