import {
  LayoutDashboard,
  FolderKanban,
  Send,
  ScrollText,
  Users,
  GitBranch,
  Webhook,
  BookOpen,
  TerminalSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  labelKey: string; // messages 의 nav.* 키
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  external?: boolean;
};

export type NavGroup = { labelKey: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "manage",
    items: [
      { labelKey: "overview", href: "/dashboard", icon: LayoutDashboard, exact: true },
      { labelKey: "projects", href: "/projects", icon: FolderKanban },
    ],
  },
  {
    labelKey: "developer",
    items: [
      { labelKey: "apiDocs", href: "/docs", icon: BookOpen, external: true },
      { labelKey: "apiTester", href: "/tester", icon: TerminalSquare },
    ],
  },
  {
    labelKey: "settings",
    items: [{ labelKey: "settings", href: "/settings", icon: Settings, exact: true }],
  },
];

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.external) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}

/** 프로젝트 상세 경로(/projects/{id}[/...])면 id 반환. 목록(/projects)은 null. */
export function projectIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/** 프로젝트 전용(상세) 사이드바 네비 */
export function projectNavGroups(id: string): NavGroup[] {
  return [
    {
      labelKey: "project",
      items: [
        { labelKey: "overview", href: `/projects/${id}`, icon: LayoutDashboard, exact: true },
        { labelKey: "send", href: `/projects/${id}/send`, icon: Send },
        { labelKey: "logs", href: `/projects/${id}/logs`, icon: ScrollText },
      ],
    },
    {
      labelKey: "engagement",
      items: [
        { labelKey: "segments", href: `/projects/${id}/segments`, icon: Users },
        { labelKey: "journeys", href: `/projects/${id}/journeys`, icon: GitBranch },
        { labelKey: "webhooks", href: `/projects/${id}/webhooks`, icon: Webhook },
      ],
    },
    {
      labelKey: "settings",
      items: [{ labelKey: "settings", href: `/projects/${id}/settings`, icon: Settings }],
    },
  ];
}
