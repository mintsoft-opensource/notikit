"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LogOut, UserCircle, KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { DataRow } from "@/components/ui/data-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession, adminApi, logout } from "@/lib/admin-client";

/** 프로필 — 내 계정 정보와 비밀번호 변경 */
export default function ProfilePage() {
  const t = useTranslations("profile");
  const th = useTranslations("header");
  const { user } = useSession();

  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy || mismatch || next.length < 8) return;
    setBusy(true);
    try {
      await adminApi("/api/admin/me/password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      toast.success(t("passwordChanged"));
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("passwordChangeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>{t("myAccount")}</CardTitle>
              <CardDescription>{t("myAccountDesc")}</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await logout();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : th("logoutFailed"));
                }
              }}
            >
              <LogOut aria-hidden="true" className="h-4 w-4" /> {th("logout")}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
                <UserCircle aria-hidden="true" className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                {user ? <p className="truncate text-base font-bold">{user.email}</p> : <Skeleton className="h-5 w-48" />}
                {user?.role && <Badge variant={user.role === "owner" ? "primary" : "neutral"}>{user.role}</Badge>}
              </div>
            </div>
            <dl className="space-y-3 border-t border-border pt-4 [&_dd]:min-w-0 [&_dd]:break-all">
              <DataRow label={t("emailLabel")} value={user ? user.email : <Skeleton className="h-4 w-40" />} mono />
              <DataRow label={t("roleLabel")} value={user ? user.role : <Skeleton className="h-4 w-16" />} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <KeyRound aria-hidden="true" className="h-4 w-4" /> {t("passwordTitle")}
              </CardTitle>
              <CardDescription>{t("passwordDesc")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={changePassword} className="grid gap-4 sm:grid-cols-2 sm:items-start">
              <div className="sm:col-span-2">
                <Field label={t("currentPassword")}>
                  <Input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
                </Field>
              </div>
              <Field label={t("newPassword")}>
                <Input type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              </Field>
              <Field label={t("confirmPassword")} hint={mismatch ? t("passwordMismatch") : undefined}>
                <Input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
              <div className="border-t border-border pt-4 sm:col-span-2 sm:flex sm:justify-end">
                <Button type="submit" size="sm" disabled={busy || mismatch || next.length < 8 || !current}>
                  {busy ? t("changing") : t("changePassword")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
