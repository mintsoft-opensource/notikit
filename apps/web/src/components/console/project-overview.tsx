"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Send, ScrollText, Settings, ArrowRight, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Stats = { devices?: number; users?: number; messages?: number; activeDevices?: number } & Record<string, unknown>;

const LINKS = (id: string) => [
  { href: `/projects/${id}/send`, label: "발송", icon: Send, desc: "개인·토픽·세그먼트·전체" },
  { href: `/projects/${id}/logs`, label: "로그", icon: ScrollText, desc: "상태·성공/실패 집계" },
  { href: `/projects/${id}/settings`, label: "설정", icon: Settings, desc: "정책·Firebase" },
];

export function ProjectOverview({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [stats, setStats] = React.useState<Stats | null>(null);

  React.useEffect(() => {
    let alive = true;
    adminApi<Stats>(`/api/admin/projects/${projectId}/stats`)
      .then((d) => alive && setStats(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId]);

  const num = (v: unknown) => (typeof v === "number" ? v : stats ? 0 : "…");

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title={project?.name ?? "프로젝트"}
        description="프로젝트 상세"
        actions={project ? <Badge variant={project.environment === "production" ? "primary" : "neutral"}>{project.environment}</Badge> : undefined}
      />

      {project && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted-foreground">api-key</p>
              <p className="truncate font-mono text-sm">{project.apiKey}</p>
            </div>
            <div className="flex items-center gap-2">
              {project.hasFirebase ? <Badge variant="success">Firebase 설정됨</Badge> : <Badge variant="neutral">log-only</Badge>}
              <button
                type="button"
                onClick={async () => { try { await navigator.clipboard.writeText(project.apiKey); toast.success("api-key 복사됨"); } catch { toast.error("복사 실패"); } }}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-muted"
              >
                <Copy className="h-3.5 w-3.5" /> 복사
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="디바이스" value={num(stats?.devices)} />
        <StatCard label="유저" value={num(stats?.users)} />
        <StatCard label="발송" value={num(stats?.messages)} />
        <StatCard label="활성 디바이스" value={num(stats?.activeDevices)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {LINKS(projectId).map((l) => {
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href}>
              <Card className="group transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-3 p-5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-bold">{l.label}</p>
                    <p className="text-xs text-muted-foreground">{l.desc}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
