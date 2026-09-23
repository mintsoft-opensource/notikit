import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BookOpen } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { listDocs } from "@/lib/docs";

/** 첫 문서로 보낸다 — 어떤 파일이 첫 번째인지 코드가 알 필요는 없다. */
export default async function GuideIndex() {
  const docs = await listDocs();
  // 빈 슬러그로 보내면 [slug] 가 404 를 낸다. 문서 폴더가 비었다는 사실을 그대로 알린다.
  if (docs.length === 0) {
    const t = await getTranslations("guide");
    return <EmptyState icon={BookOpen} title={t("emptyTitle")} description={t("emptyDesc")} />;
  }
  redirect(`/guide/${docs[0].slug}`);
}
