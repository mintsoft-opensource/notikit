"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    // 헤더의 다른 아이콘 버튼과 같은 Button — 직접 만든 button 에는 포커스 링이 없어
    // 키보드로 헤더를 지날 때 이 버튼에서만 위치가 보이지 않았다.
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={dark ? t("toLightMode") : t("toDarkMode")}
      className="text-muted-foreground hover:text-foreground"
    >
      {dark ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
    </Button>
  );
}
