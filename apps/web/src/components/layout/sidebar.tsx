"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isActive, projectIdFromPath, projectNavGroups, type NavItem } from "./nav";

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noopener noreferrer" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
        active ? "bg-accent-soft text-primary" : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
      )}
    >
      {active && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />}
      <Icon className={cn("h-[17px] w-[17px]", active ? "text-primary" : "text-muted-foreground")} strokeWidth={2} />
      <span>{item.label}</span>
    </Link>
  );
}

export function SidebarNav({ pathname }: { pathname: string }) {
  const projectId = projectIdFromPath(pathname);
  const groups = projectId ? projectNavGroups(projectId) : NAV_GROUPS;
  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
      {projectId && (
        <Link
          href="/projects"
          className="flex items-center gap-1.5 px-3 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> 프로젝트 목록
        </Link>
      )}
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 px-3 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <div className="flex h-16 items-center border-b border-border px-6">
      <Link href="/dashboard" className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bell className="h-4 w-4" />
        </span>
        <span className="text-[15px] font-extrabold tracking-tight text-foreground">Notikit</span>
      </Link>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <SidebarBrand />
      <SidebarNav pathname={pathname} />
      <div className="border-t border-border px-6 py-4 text-[11px] text-muted-foreground">
        <p className="font-semibold text-foreground">유저 중심 푸시</p>
        <p className="mt-0.5">오픈소스 · 셀프호스트</p>
      </div>
    </aside>
  );
}
