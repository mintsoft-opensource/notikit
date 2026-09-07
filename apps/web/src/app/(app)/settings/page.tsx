"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LogOut, UserCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { useSession, logout } from "@/lib/admin-client";

/** 조직/계정 설정 — 프로젝트별 발송 정책은 프로젝트 상세 > 설정에서 관리 */
export default function SettingsPage() {
  const t = useTranslations("orgSettings");
  const th = useTranslations("header");
  const { user } = useSession();

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("accountTitle")}</CardTitle>
          <CardDescription>{t("accountDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-primary">
              <UserCircle aria-hidden="true" className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">{user?.email ?? "…"}</p>
              <p className="text-xs text-muted-foreground">{user?.role ?? ""}</p>
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
    </div>
  );
}
