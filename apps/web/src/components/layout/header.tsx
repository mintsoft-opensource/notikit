"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu, X, LogOut, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { LocaleSwitcher } from "./locale-switcher";
import { SidebarBrand, SidebarNav } from "./sidebar";
import { NAV_GROUPS, isActive, projectIdFromPath, projectNavGroups } from "./nav";
import { lockBackground } from "@/components/ui/dialog";
import { logout, useAdminErrorText } from "@/lib/admin-client";

/** 현재 경로에 해당하는 nav 그룹·항목 키 (없으면 null) */
function currentNavKeys(pathname: string): { groupKey: string; labelKey: string } | null {
  const projectId = projectIdFromPath(pathname);
  const groups = projectId ? projectNavGroups(projectId) : NAV_GROUPS;
  for (const group of groups) {
    for (const item of group.items) {
      if (isActive(pathname, item)) return { groupKey: group.labelKey, labelKey: item.labelKey };
    }
  }
  return null;
}

const CRUMB_ICON = "h-3.5 w-3.5 rtl:rotate-180";

/**
 * 헤더 조작 버튼은 전부 Button(h-9·rounded-lg·포커스 링)으로 만든다.
 * 직접 만든 `<button>` 에는 포커스 링이 없어, 키보드로 헤더를 지날 때 지금 어디에
 * 있는지 보이지 않았다. 헤더 톤(회색 → 진하게)만 여기서 덧씌운다.
 */
const ICON_BUTTON = "text-muted-foreground hover:text-foreground";

export function Header() {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const th = useTranslations("header");
  const ta = useTranslations("app");
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLButtonElement>(null);

  // 로그아웃 요청 중 재클릭 방지 — 성공하면 페이지를 떠나므로 성공 경로에선 풀지 않는다
  const [loggingOut, setLoggingOut] = React.useState(false);
  const errorText = useAdminErrorText();

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } catch (e) {
      toast.error(errorText(e, th("logoutFailed")));
      setLoggingOut(false);
    }
  }

  const navKeys = currentNavKeys(pathname);
  const title = navKeys ? t(navKeys.labelKey) : ta("name");
  // 모바일은 폭이 좁아 앱 이름·프로젝트 링크를 숨긴다 — 대신 그룹 이름으로 "어느 메뉴 아래인지"를 남긴다
  // ("참여" 처럼 그룹과 항목 이름이 겹치는 화면에서 통계인지 메뉴 그룹인지 구분된다)
  const groupLabel = navKeys && t(navKeys.groupKey) !== title ? t(navKeys.groupKey) : null;
  const projectId = projectIdFromPath(pathname);

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

  // 드로어 열림: Escape 닫기 + 포커스 트랩 + 배경 스크롤·inert 잠금 + 닫을 때 opener 로 포커스 복원.
  // inert 는 모달과 같은 규칙(lockBackground) — Tab 트랩만으로는 스크린리더 가상 커서가 뒤 화면으로 샌다.
  React.useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    const unlock = drawerRef.current ? lockBackground(drawerRef.current) : () => {};
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
      // inert 를 푼 뒤에 돌려준다 — inert 인 동안엔 focus() 가 무시된다
      unlock();
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <header className="z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur md:h-14 md:px-4">
        <Button
          ref={openerRef}
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label={th("openMenu")}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={ICON_BUTTON + " md:hidden"}
        >
          <Menu aria-hidden="true" className="h-4 w-4" />
        </Button>

        <nav aria-label={th("menu")} className="min-w-0 flex-1 text-sm">
          <ol className="flex min-w-0 items-center gap-1.5">
            <li className="hidden shrink-0 sm:block">
              <Link href="/dashboard" className="text-muted-foreground transition-colors hover:text-foreground">{ta("name")}</Link>
            </li>
            <li aria-hidden="true" className="hidden text-muted-foreground/60 sm:block"><ChevronRight className={CRUMB_ICON} /></li>
            {projectId && (
              <>
                <li className="hidden shrink-0 sm:block"><Link href="/projects" className="text-muted-foreground hover:text-foreground">{t("projects")}</Link></li>
                <li aria-hidden="true" className="hidden text-muted-foreground/60 sm:block"><ChevronRight className={CRUMB_ICON} /></li>
              </>
            )}
            {groupLabel && (
              <>
                <li className="shrink-0 text-muted-foreground">{groupLabel}</li>
                <li aria-hidden="true" className="text-muted-foreground/60"><ChevronRight className={CRUMB_ICON} /></li>
              </>
            )}
            <li aria-current="page" className="truncate font-medium text-foreground">{title}</li>
          </ol>
        </nav>

        <Button asChild variant="ghost" size="sm" className={ICON_BUTTON + " hidden sm:inline-flex"}>
          <Link href="/api-docs">{th("apiDocs")}</Link>
        </Button>
        <LocaleSwitcher />
        <ThemeToggle />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-busy={loggingOut}
          aria-label={th("logout")}
          className={ICON_BUTTON}
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
        </Button>
      </header>

      {/* 모바일 드로어 — backdrop-blur 헤더 밖(body)으로 portal 하여 fixed 가 뷰포트 기준이 되게 함 */}
      {mounted &&
        open &&
        createPortal(
          <div ref={drawerRef} className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
            <div ref={panelRef} role="dialog" aria-modal="true" aria-label={th("menu")} className="absolute inset-y-0 start-0 flex w-[320px] max-w-[88vw] flex-col bg-surface shadow-modal">
              <div className="flex items-center justify-between border-b border-border pe-2">
                <SidebarBrand />
                <Button
                  ref={closeRef}
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setOpen(false)}
                  aria-label={th("closeMenu")}
                  className={ICON_BUTTON}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
              <SidebarNav pathname={pathname} />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
