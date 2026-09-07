"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { LOCALES, LOCALE_COOKIE } from "@/i18n/locales";

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function change(next: string) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh()); // 서버 컴포넌트 재실행 → 새 로케일 메시지 로드, 완료 시 pending 해제
  }

  return (
    <label className="relative flex items-center" aria-label={t("language")}>
      <Globe className="pointer-events-none absolute left-2 h-4 w-4 text-muted-foreground" />
      <select
        value={locale}
        onChange={(e) => change(e.target.value)}
        disabled={pending}
        aria-label={t("language")}
        className="h-9 appearance-none rounded-md border border-border bg-surface pl-7 pr-2 text-[13px] text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
