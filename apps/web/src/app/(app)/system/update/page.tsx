import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/layout/page-header";
import { UpdatePanel } from "@/components/console/update-panel";

export default async function UpdatePage() {
  const t = await getTranslations("update");
  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <UpdatePanel />
    </div>
  );
}
