"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LogOut, UserCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { MembersPanel } from "@/components/console/members-panel";
import { useSession, logout } from "@/lib/admin-client";

/** 계정 — 내 프로필 + 조직 멤버 관리 */
export default function AccountPage() {
  const t = useTranslations("account");
  const th = useTranslations("header");
  const { user } = useSession();

  return (
    <div className="w-full space-y-5">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("myAccount")}</CardTitle>
          <CardDescription>{t("myAccountDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
              <UserCircle aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user?.email ?? "…"}</p>
              {user?.role && <Badge variant={user.role === "owner" ? "primary" : "neutral"}>{user.role}</Badge>}
            </div>
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
        </CardContent>
      </Card>

      <MembersPanel currentRole={user?.role} />
    </div>
  );
}
