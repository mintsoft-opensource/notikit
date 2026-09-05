"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, LogIn, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<"loading" | "login" | "register">("loading");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [orgName, setOrgName] = React.useState("");
  const [bootstrapToken, setBootstrapToken] = React.useState("");
  const [tokenRequired, setTokenRequired] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/me");
        const j = await r.json();
        if (j.data?.authenticated) {
          router.replace("/dashboard");
          return;
        }
        setTokenRequired(!!j.data?.bootstrapTokenRequired);
        setMode(j.data?.needsBootstrap ? "register" : "login");
      } catch {
        setMode("login");
      }
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const path = mode === "register" ? "/api/admin/register" : "/api/admin/login";
      const body = mode === "register" ? { org_name: orgName || undefined, email, password } : { email, password };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (mode === "register" && tokenRequired) headers["x-bootstrap-token"] = bootstrapToken;
      const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error ?? "실패");
      toast.success(mode === "register" ? "관리자 계정 생성됨" : "로그인되었습니다");
      router.replace("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Bell className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-extrabold tracking-tight">Notikit</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "register" ? "최초 관리자 계정을 만드세요" : "관리 콘솔 로그인"}
          </p>
        </div>

        <Card>
          <CardContent className="p-6">
            {mode === "loading" ? (
              <p className="py-6 text-center text-sm text-muted-foreground">불러오는 중…</p>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                {mode === "register" && (
                  <div className="space-y-1">
                    <Label htmlFor="org">조직 이름 (선택)</Label>
                    <Input id="org" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="My Company" autoComplete="organization" />
                  </div>
                )}
                {mode === "register" && tokenRequired && (
                  <div className="space-y-1">
                    <Label htmlFor="bootstrap">부트스트랩 토큰</Label>
                    <Input id="bootstrap" type="password" required value={bootstrapToken} onChange={(e) => setBootstrapToken(e.target.value)} placeholder="BOOTSTRAP_TOKEN" />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="email">이메일</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoComplete="email" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="password">비밀번호{mode === "register" && " (8자 이상)"}</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={mode === "register" ? 8 : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                  />
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {mode === "register" ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                  {busy ? "처리 중…" : mode === "register" ? "계정 생성" : "로그인"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
