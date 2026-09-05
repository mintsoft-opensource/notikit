"use client";

import * as React from "react";
import { createPortal } from "react-dom";
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
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLButtonElement>(null);

  // 라우트 변경 시 드로어 자동 닫기
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 데스크톱(md+) 로 리사이즈되면 드로어(모바일 전용) 닫기 — 숨겨진 트랩 잔존 방지
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => mq.matches && setOpen(false);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 드로어 열림: Escape 닫기 + 포커스 트랩 + 배경 스크롤 잠금 + 닫을 때 opener 로 포커스 복원
  React.useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus(); // 포커스 복원
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur md:h-16 md:px-6">
        <button
          ref={openerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          aria-haspopup="dialog"
          aria-expanded={open}
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
      </header>

      {/* 모바일 드로어 — backdrop-blur 헤더 밖(body)으로 portal 하여 fixed 가 뷰포트 기준이 되게 함 */}
      {mounted &&
        open &&
        createPortal(
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
            <div ref={panelRef} role="dialog" aria-modal="true" aria-label="메뉴" className="absolute inset-y-0 left-0 flex w-[320px] max-w-[88vw] flex-col bg-surface shadow-modal">
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
          </div>,
          document.body
        )}
    </>
  );
}
