"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LogIn, UserPlus } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useAdminErrorText } from "@/lib/admin-client";

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("login");
  const errorText = useAdminErrorText();
  const ta = useTranslations("app");
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
      if (!r.ok || !j.success) throw new Error(j.error ?? t("failed"));
      toast.success(mode === "register" ? t("created") : t("loggedIn"));
      router.replace("/dashboard");
    } catch (err) {
      toast.error(errorText(err, t("failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <LogoMark className="h-12 w-12" />
          <h1 translate="no" className="text-xl font-extrabold tracking-tight">{ta("name")}</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "register" ? t("firstAdmin") : t("consoleLogin")}
          </p>
        </div>

        <Card>
          <CardContent className="p-6">
            {mode === "loading" ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("loading")}</p>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                {mode === "register" && (
                  <div className="space-y-1">
                    <Label htmlFor="org">{t("orgName")}</Label>
                    <Input id="org" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="My Company" autoComplete="organization" />
                  </div>
                )}
                {mode === "register" && tokenRequired && (
                  <div className="space-y-1">
                    <Label htmlFor="bootstrap">{t("bootstrapToken")}</Label>
                    <Input id="bootstrap" type="password" required spellCheck={false} autoComplete="off" value={bootstrapToken} onChange={(e) => setBootstrapToken(e.target.value)} placeholder="BOOTSTRAP_TOKEN" />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="email">{t("email")}</Label>
                  <Input id="email" type="email" required spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoComplete="email" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="password">{mode === "register" ? t("passwordMin") : t("password")}</Label>
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
                  {mode === "register" ? <UserPlus aria-hidden="true" className="h-4 w-4" /> : <LogIn aria-hidden="true" className="h-4 w-4" />}
                  {busy ? t("processing") : mode === "register" ? t("createAccount") : t("login")}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
