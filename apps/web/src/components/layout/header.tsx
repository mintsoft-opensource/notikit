"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { SidebarBrand, SidebarNav } from "./sidebar";
import { NAV_GROUPS, isActive } from "./nav";

function currentTitle(pathname: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isActive(pathname, item)) return item.label;
    }
  }
  return "Notikit";
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // 라우트 변경 시 드로어 자동 닫기
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur md:h-16 md:px-6">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="메뉴 열기"
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <span className="flex-1 truncate text-[15px] font-bold tracking-tight md:text-base">{currentTitle(pathname)}</span>

      <Link
        href="/docs"
        target="_blank"
        rel="noopener noreferrer"
        className="hidden rounded-md px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground sm:inline-flex"
      >
        API 문서
      </Link>
      <ThemeToggle />

      {/* 모바일 드로어 */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-[320px] max-w-[88vw] flex-col bg-surface shadow-modal">
            <div className="flex items-center justify-between border-b border-border pr-2">
              <SidebarBrand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="메뉴 닫기"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarNav pathname={pathname} />
          </div>
        </div>
      )}
    </header>
  );
}
