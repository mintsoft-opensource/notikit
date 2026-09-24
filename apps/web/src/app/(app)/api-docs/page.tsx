import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { ApiFrame } from "@/components/console/api-frame";

export default async function ApiDocsPage() {
  const t = await getTranslations("nav");
  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("apiDocs")} />
      <Card className="min-w-0 overflow-hidden">
        <ApiFrame title={t("apiDocs")} />
      </Card>
    </div>
  );
}
