"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { LogoMark } from "@/components/brand/logo";
import { NAV_GROUPS, isActive, projectIdFromPath, projectNavGroups, type NavGroup, type NavItem } from "./nav";

function NavLink({ item, label, pathname }: { item: NavItem; label: string; pathname: string }) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noopener noreferrer" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 조작 요소 규칙과 같은 36px·rounded-lg. 포커스 링이 없으면 키보드로 메뉴를 훑을 때
        // 지금 어느 항목에 있는지 보이지 않는다(Button 과 같은 링을 쓴다).
        "relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-md font-semibold transition-colors",
        FOCUS_RING,
        // 현재 위치는 면 색 + 시작 쪽 막대 둘로 표시한다 — 틴트만으로는 hover 와 구분이 약하다
        active
          ? "bg-accent-soft text-primary before:absolute before:inset-y-2 before:start-0 before:w-[3px] before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
      )}
    >
      <Icon aria-hidden="true" className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} strokeWidth={2} />
      <span>{label}</span>
    </Link>
  );
}

const COLLAPSED_KEY = "nav-collapsed";

function readCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 접어 둔 그룹 — 브라우저에 기억한다. 프로젝트 메뉴는 20개가 넘어 한 화면에 다 들어오지 않는다.
 * 기본은 전부 펼침이다: 처음 온 사람이 무엇이 있는지 볼 수 있어야 한다.
 * 키는 화면(전역/프로젝트)별로 나눈다 — 둘 다 "manage" 그룹이 있다.
 */
function useCollapsedGroups(scope: string, activeKey: string | null) {
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  React.useEffect(() => setCollapsed(readCollapsed()), []);

  const update = React.useCallback((next: (prev: string[]) => string[]) => {
    setCollapsed((prev) => {
      const value = next(prev);
      if (value === prev) return prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(value));
      } catch {}
      return value;
    });
  }, []);

  // 접힌 그룹 안의 화면으로 들어오면 펼친다 — 지금 어디 있는지가 메뉴에서 사라지면 안 된다
  const activeId = activeKey ? `${scope}:${activeKey}` : null;
  React.useEffect(() => {
    if (activeId) update((prev) => (prev.includes(activeId) ? prev.filter((k) => k !== activeId) : prev));
  }, [activeId, update]);

  return {
    isOpen: (key: string) => !collapsed.includes(`${scope}:${key}`),
    toggle: (key: string) => {
      const id = `${scope}:${key}`;
      update((prev) => (prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]));
    },
  };
}

function NavSection({
  group,
  label,
  open,
  onToggle,
  pathname,
}: {
  group: NavGroup;
  label: string;
  open: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  const t = useTranslations("nav");
  const listId = React.useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className={cn(
          // 머리글 글씨는 Eyebrow 와 같은 값 — 여기만 다르면 같은 층위가 다르게 읽힌다
          "flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground",
          FOCUS_RING
        )}
      >
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", !open && "-rotate-90 rtl:rotate-90")} />
      </button>
      <ul id={listId} hidden={!open} className="space-y-0.5">
        {group.items.map((item) => (
          <li key={item.href}>
            <NavLink item={item} label={t(item.labelKey)} pathname={pathname} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SidebarNav({ pathname }: { pathname: string }) {
  const t = useTranslations("nav");
  const projectId = projectIdFromPath(pathname);
  const groups = projectId ? projectNavGroups(projectId) : NAV_GROUPS;
  const activeGroup = groups.find((g) => g.items.some((item) => isActive(pathname, item)));
  const { isOpen, toggle } = useCollapsedGroups(projectId ? "project" : "global", activeGroup?.labelKey ?? null);
  return (
    <nav className="flex-1 space-y-2 overflow-y-auto px-2 py-3">
      {projectId && (
        <Link
          href="/projects"
          className={cn(
            "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-md font-semibold text-muted-foreground transition-colors hover:text-foreground",
            FOCUS_RING
          )}
        >
          <ChevronLeft aria-hidden="true" className="size-4 rtl:rotate-180" /> {t("projectList")}
        </Link>
      )}
      {groups.map((group) =>
        // 항목이 하나뿐인 그룹은 접을 이유가 없다 — 머리글 없이 항목만 둔다
        group.items.length === 1 ? (
          <NavLink key={group.labelKey} item={group.items[0]} label={t(group.items[0].labelKey)} pathname={pathname} />
        ) : (
          <NavSection
            key={group.labelKey}
            group={group}
            label={t(group.labelKey)}
            open={isOpen(group.labelKey)}
            onToggle={() => toggle(group.labelKey)}
            pathname={pathname}
          />
        )
      )}
    </nav>
  );
}

export function SidebarBrand() {
  const t = useTranslations("app");
  return (
    <div className="flex h-14 items-center border-b border-border px-4">
      <Link href="/dashboard" className={cn("flex items-center gap-2.5 rounded-lg", FOCUS_RING)}>
        <LogoMark className="h-8 w-8" />
        <span translate="no" className="text-lg font-extrabold tracking-tight text-foreground">{t("name")}</span>
      </Link>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-surface md:flex">
      <SidebarBrand />
      <SidebarNav pathname={pathname} />
    </aside>
  );
}
