"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/layout/page-header";
import { MembersPanel } from "@/components/console/members-panel";
import { useSession } from "@/lib/admin-client";

/** 계정 — 조직 멤버 관리. 내 프로필은 프로필 화면에서. */
export default function AccountPage() {
  const t = useTranslations("account");
  const { user } = useSession();

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <MembersPanel currentRole={user?.role} />
    </div>
  );
}
