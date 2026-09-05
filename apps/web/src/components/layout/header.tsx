"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut } from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "./theme-toggle";
import { SidebarBrand, SidebarNav } from "./sidebar";
import { NAV_GROUPS, isActive } from "./nav";
import { logout } from "@/lib/admin-client";

async function handleLogout() {
  try {
    await logout();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "로그아웃 실패");
  }
}

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
  const closeRef = React.useRef<HTMLButtonElement>(null);

  // 라우트 변경 시 드로어 자동 닫기
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 드로어 열림: Escape 닫기 + 닫기 버튼 포커스 + 배경 스크롤 잠금
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

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
      <button
        type="button"
        onClick={handleLogout}
        aria-label="로그아웃"
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
      >
        <LogOut className="h-[18px] w-[18px]" />
      </button>

      {/* 모바일 드로어 */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <div role="dialog" aria-modal="true" aria-label="메뉴" className="absolute inset-y-0 left-0 flex w-[320px] max-w-[88vw] flex-col bg-surface shadow-modal">
            <div className="flex items-center justify-between border-b border-border pr-2">
              <SidebarBrand />
              <button
                ref={closeRef}
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
