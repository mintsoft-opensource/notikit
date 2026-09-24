"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/logo";
import { NAV_GROUPS, isActive, projectIdFromPath, projectNavGroups, type NavItem } from "./nav";

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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        active ? "bg-accent-soft text-primary" : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
      )}
    >
      <Icon aria-hidden="true" className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} strokeWidth={2} />
      <span>{label}</span>
    </Link>
  );
}

export function SidebarNav({ pathname }: { pathname: string }) {
  const t = useTranslations("nav");
  const projectId = projectIdFromPath(pathname);
  const groups = projectId ? projectNavGroups(projectId) : NAV_GROUPS;
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
      {projectId && (
        <Link
          href="/projects"
          className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-md font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4 rtl:rotate-180" /> {t("projectList")}
        </Link>
      )}
      {groups.map((group) => (
        <div key={group.labelKey}>
          <p className="mb-1.5 px-2.5 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground">{t(group.labelKey)}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} label={t(item.labelKey)} pathname={pathname} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SidebarBrand() {
  const t = useTranslations("app");
  return (
    <div className="flex h-14 items-center border-b border-border px-4">
      <Link href="/dashboard" className="flex items-center gap-2.5">
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
