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
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  external?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "관리",
    items: [
      { label: "개요", href: "/dashboard", icon: LayoutDashboard, exact: true },
      { label: "프로젝트", href: "/projects", icon: FolderKanban },
      { label: "발송", href: "/send", icon: Send },
      { label: "로그", href: "/logs", icon: ScrollText },
    ],
  },
  {
    label: "참여",
    items: [
      { label: "세그먼트", href: "/segments", icon: Users },
      { label: "저니", href: "/journeys", icon: GitBranch },
      { label: "웹훅", href: "/webhooks", icon: Webhook },
    ],
  },
  {
    label: "개발자",
    items: [
      { label: "API 문서", href: "/docs", icon: BookOpen, external: true },
      { label: "API 테스터", href: "/tester", icon: TerminalSquare },
    ],
  },
  {
    label: "설정",
    items: [{ label: "설정", href: "/settings", icon: Settings, exact: true }],
  },
];

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.external) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}
