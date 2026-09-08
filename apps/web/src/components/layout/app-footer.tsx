import { useTranslations } from "next-intl";

/** 페이지 바닥선 — 셸이 flex-col 이라 이게 없으면 하단이 무근거 공백으로 남는다 */
export function AppFooter() {
  const t = useTranslations("app");
  return (
    <footer className="border-t border-border bg-surface-alt/40 px-4 py-4 md:px-8">
      <div className="flex flex-col gap-1 text-2xs text-muted-foreground md:flex-row md:items-center md:justify-between">
        <p>
          <span translate="no" className="font-semibold text-foreground/80">
            {t("name")}
          </span>
          <span className="mx-1.5">·</span>
          {t("tagline")}
        </p>
        <p>{t("openSourceSelfHost")}</p>
      </div>
    </footer>
  );
}
