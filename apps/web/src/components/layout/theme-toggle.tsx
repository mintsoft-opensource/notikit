"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { useDarkMode } from "./use-dark-mode";

export function ThemeToggle() {
  const t = useTranslations("common");
  // 클래스 변화를 관찰하므로 다른 곳에서 테마가 바뀌어도 아이콘이 어긋나지 않는다
  const dark = useDarkMode();

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? t("toLightMode") : t("toDarkMode")}
      className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
    >
      {dark ? <Sun aria-hidden="true" className="h-[18px] w-[18px]" /> : <Moon aria-hidden="true" className="h-[18px] w-[18px]" />}
    </button>
  );
}
