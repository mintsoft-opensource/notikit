"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { LogOut, UserCircle, KeyRound, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { DataRow } from "@/components/ui/data-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession, adminApi, logout, useAdminErrorText } from "@/lib/admin-client";

/** 역할이 실제로 할 수 있는 일 — 화면에 역할 이름만 있으면 "내가 뭘 할 수 있는지"를 알 수 없다 */
const ROLE_DESC = { owner: "roleOwnerDesc", admin: "roleAdminDesc", viewer: "roleViewerDesc" } as const;

/** 소속 조직 — `/api/admin/org` 이 이미 주는 값(이름·멤버 수·프로젝트 수·개설일) */
type Org = { id: string; name: string; createdAt: string; members: number; projects: number };

/** 프로필 — 내 계정 정보와 비밀번호 변경 */
export default function ProfilePage() {
  const t = useTranslations("profile");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const th = useTranslations("header");
  const locale = useLocale();
  const { user } = useSession();
  const [org, setOrg] = React.useState<Org | null>(null);
  const [orgFailed, setOrgFailed] = React.useState(false);
  const [orgReady, setOrgReady] = React.useState(false);
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);

  React.useEffect(() => {
    adminApi<{ org: Org | null }>("/api/admin/org")
      // superadmin 은 org 컨텍스트가 없어 null 이 온다 — 그때는 카드를 숨긴다
      .then((d) => setOrg(d.org))
      .catch(() => setOrgFailed(true))
      .finally(() => setOrgReady(true));
  }, []);

  const roleDescKey = user ? ROLE_DESC[user.role as keyof typeof ROLE_DESC] : undefined;

  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  const [tab, setTab] = React.useState<"account" | "password">("account");

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
      toast.error(errorText(err, t("passwordChangeFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Tabs
        idPrefix="profile"
        label={t("title")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "account", label: t("myAccount"), icon: <UserCircle aria-hidden="true" className="h-4 w-4" /> },
          { value: "password", label: t("passwordTitle"), icon: <KeyRound aria-hidden="true" className="h-4 w-4" /> },
        ]}
      />

      {tab === "account" && (
        <TabPanel idPrefix="profile" value="account">
          <div className="grid gap-4 lg:grid-cols-2">
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
                    toast.error(errorText(e, th("logoutFailed")));
                  }
                }}
              >
                <LogOut aria-hidden="true" className="h-4 w-4" /> {th("logout")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
                  <UserCircle aria-hidden="true" className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  {user ? <p className="truncate text-base font-bold">{user.email}</p> : <Skeleton className="h-5 w-48" />}
                  {user?.role && <Badge variant={user.role === "owner" ? "primary" : "neutral"}>{user.role}</Badge>}
                </div>
              </div>
              <dl className="space-y-3 border-t border-border pt-3 [&_dd]:min-w-0 [&_dd]:break-all">
                <DataRow label={t("emailLabel")} value={user ? user.email : <Skeleton className="h-4 w-40" />} mono />
                <DataRow label={t("roleLabel")} value={user ? user.role : <Skeleton className="h-4 w-16" />} />
              </dl>
              {/* 역할 이름만으로는 권한을 알 수 없다 — 할 수 있는 일을 한 줄로 적는다 */}
              {roleDescKey && <p className="text-xs text-muted-foreground">{t(roleDescKey)}</p>}
            </CardContent>
          </Card>

          {(org || !orgReady || orgFailed) && (
            <Card className="min-w-0">
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-1.5">
                    <Building2 aria-hidden="true" className="h-4 w-4" /> {t("organization")}
                  </CardTitle>
                  <CardDescription>{t("organizationDesc")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {orgFailed ? (
                  <p className="text-sm text-muted-foreground">{tc("loadFailed")}</p>
                ) : (
                  <dl className="space-y-3 [&_dd]:min-w-0">
                    <DataRow label={t("orgNameLabel")} value={org ? org.name : <Skeleton className="h-4 w-32" />} />
                    {/* 수치는 콘솔 전체와 같이 tabular-nums — 여기만 mono 면 같은 숫자가 다른 서체로 보인다 */}
                    <DataRow
                      label={t("orgMembersLabel")}
                      value={org ? <span className="tabular-nums">{org.members.toLocaleString(locale)}</span> : <Skeleton className="h-4 w-10" />}
                    />
                    <DataRow
                      label={t("orgProjectsLabel")}
                      value={org ? <span className="tabular-nums">{org.projects.toLocaleString(locale)}</span> : <Skeleton className="h-4 w-10" />}
                    />
                    <DataRow label={tc("createdAt")} value={org ? df.format(new Date(org.createdAt)) : <Skeleton className="h-4 w-24" />} />
                  </dl>
                )}
              </CardContent>
            </Card>
          )}
          </div>
        </TabPanel>
      )}

      {tab === "password" && (
        <TabPanel idPrefix="profile" value="password">
          <Card className="min-w-0">
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  <KeyRound aria-hidden="true" className="h-4 w-4" /> {t("passwordTitle")}
                </CardTitle>
                <CardDescription>{t("passwordDesc")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={changePassword} className="grid gap-3 sm:grid-cols-2 sm:items-start">
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
                <div className="border-t border-border pt-3 sm:col-span-2 sm:flex sm:justify-end">
                  <Button type="submit" disabled={busy || mismatch || next.length < 8 || !current}>
                    {busy ? t("changing") : t("changePassword")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabPanel>
      )}
    </div>
  );
}
