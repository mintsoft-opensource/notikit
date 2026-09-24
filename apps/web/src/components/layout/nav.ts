import {
  RefreshCw,
  FileText,
  Hourglass,
  CalendarClock,
  LayoutDashboard,
  FolderKanban,
  Send,
  Users,
  UsersRound,
  Smartphone,
  Radio,
  BellOff,
  Megaphone,
  MailCheck,
  BarChart3,
  PackageMinus,
  GitBranch,
  Webhook,
  BookOpen,
  Activity,
  UserCog,
  UserRound,
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
      { labelKey: "system", href: "/system", icon: Activity, exact: true },
      { labelKey: "updates", href: "/system/update", icon: RefreshCw },
    ],
  },
  {
    labelKey: "developer",
    items: [
      { labelKey: "apiDocs", href: "/api-docs", icon: BookOpen },
      { labelKey: "guide", href: "/guide", icon: FileText },
    ],
  },
  {
    // 그룹 이름을 "settings" 로 두면 안의 "설정" 항목과 이름이 겹쳐 스크린리더·헤더 경로가 "설정 › 설정" 이 된다
    labelKey: "organization",
    items: [
      { labelKey: "profile", href: "/profile", icon: UserRound, exact: true },
      { labelKey: "account", href: "/account", icon: UserCog, exact: true },
      { labelKey: "settings", href: "/settings", icon: Settings, exact: true },
    ],
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
      // 설정은 프로젝트 그룹 안에 둔다 — 따로 "설정" 그룹을 만들면 그룹·항목 이름이 겹친다
      items: [
        { labelKey: "overview", href: `/projects/${id}`, icon: LayoutDashboard, exact: true },
        { labelKey: "settings", href: `/projects/${id}/settings`, icon: Settings },
      ],
    },
    {
      labelKey: "send",
      items: [
        { labelKey: "sendSingle", href: `/projects/${id}/send/single`, icon: Send },
        { labelKey: "sendMulti", href: `/projects/${id}/send/multi`, icon: Users },
        { labelKey: "sendBroadcast", href: `/projects/${id}/send/broadcast`, icon: Megaphone },
        { labelKey: "sendTopic", href: `/projects/${id}/send/topic`, icon: Radio },
        { labelKey: "templates", href: `/projects/${id}/templates`, icon: FileText },
        { labelKey: "schedules", href: `/projects/${id}/schedules`, icon: CalendarClock },
        { labelKey: "queue", href: `/projects/${id}/queue`, icon: Hourglass },
      ],
    },
    {
      labelKey: "logs",
      items: [
        { labelKey: "logsSingle", href: `/projects/${id}/logs/single`, icon: MailCheck },
        { labelKey: "logsTopic", href: `/projects/${id}/logs/topic`, icon: Megaphone },
      ],
    },
    {
      labelKey: "stats",
      items: [
        { labelKey: "statsActivity", href: `/projects/${id}/activity`, icon: Activity },
        { labelKey: "statsEngagement", href: `/projects/${id}/engagement`, icon: BarChart3 },
        { labelKey: "statsInstalls", href: `/projects/${id}/installs`, icon: PackageMinus },
      ],
    },
    {
      labelKey: "audience",
      items: [
        { labelKey: "users", href: `/projects/${id}/users`, icon: UsersRound },
        { labelKey: "devices", href: `/projects/${id}/devices`, icon: Smartphone },
        { labelKey: "topics", href: `/projects/${id}/topics`, icon: Radio },
        { labelKey: "suppressions", href: `/projects/${id}/suppressions`, icon: BellOff },
      ],
    },
    {
      labelKey: "engagement",
      items: [
        { labelKey: "journeys", href: `/projects/${id}/journeys`, icon: GitBranch },
        { labelKey: "webhooks", href: `/projects/${id}/webhooks`, icon: Webhook },
      ],
    },
  ];
}
