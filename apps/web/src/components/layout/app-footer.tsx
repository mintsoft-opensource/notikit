import { useTranslations } from "next-intl";

/**
 * 셸 바닥에 **항상 붙어 있는** 푸터. 스크롤은 위쪽 main 에서만 일어난다.
 *
 * shrink-0 이 없으면 콘텐츠가 길 때 flex 가 푸터를 눌러 글자가 잘린다 —
 * 스크롤되지 않는 영역이라 한 번 눌리면 되돌릴 방법이 없다.
 */
export function AppFooter() {
  const t = useTranslations("app");
  return (
    <footer className="shrink-0 border-t border-border bg-surface-alt/40 px-3 py-3 md:px-5">
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
