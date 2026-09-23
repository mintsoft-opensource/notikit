import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/layout/page-header";
import { listDocs } from "@/lib/docs";
import { DocNav } from "@/components/console/doc-nav";

/**
 * 문서 셸 — 사이드바는 `apps/web/docs/*.md` 목록에서 만들어진다.
 * 파일을 넣으면 링크가 생기고, 지우면 사라진다. 코드를 고칠 일이 없다.
 */
export default async function GuideLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("guide");
  const docs = await listDocs();

  // 문서가 하나도 없으면 목차 없이 본문(안내)만 — 404 로 막으면 메뉴를 눌렀는데 "없는 페이지"가 된다
  if (docs.length === 0) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <div className="border border-border bg-surface shadow-card">{children}</div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {/* 목차는 고정폭, 본문은 남는 폭 전부. min-w-0 이 없으면 넓은 표가 목차를 밀어낸다. */}
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <DocNav docs={docs} label={t("toc")} />
        <div className="min-w-0 border border-border bg-surface px-4 py-3 shadow-card">
          {children}
        </div>
      </div>
    </div>
  );
}
