import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/layout/page-header";
import { ApiFrame } from "@/components/console/api-frame";

export default async function ApiDocsPage() {
  const t = await getTranslations("nav");
  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("apiDocs")} />
      <div className="min-w-0 overflow-hidden border border-border bg-surface shadow-card">
        <ApiFrame title={t("apiDocs")} />
      </div>
    </div>
  );
}
