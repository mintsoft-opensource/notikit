"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ChevronDown, Globe } from "lucide-react";
import { LOCALES, LOCALE_COOKIE } from "@/i18n/locales";
import { FOCUS_RING } from "@/components/ui/focus-ring";

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
      <Globe aria-hidden="true" className="pointer-events-none absolute start-2 size-4 text-muted-foreground" />
      <select
        value={locale}
        onChange={(e) => change(e.target.value)}
        disabled={pending}
        aria-label={t("language")}
        className={`h-9 appearance-none rounded-lg border border-border bg-surface ps-7 pe-7 shadow-card text-sm text-foreground transition-colors hover:bg-surface-muted ${FOCUS_RING}`}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      {/* appearance-none 은 OS 가 그려 주던 화살표까지 지운다 — 펼칠 수 있는 칸임을
          알리는 표시가 없으면 그냥 글자로 보인다(Select 와 같은 규칙) */}
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-2 size-4 text-muted-foreground/70" />
    </label>
  );
}
