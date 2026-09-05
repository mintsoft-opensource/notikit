"use client";

import * as React from "react";
import Link from "next/link";
import { FolderKanban, Send, ScrollText, TerminalSquare, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard, TokenRequired } from "@/components/console/shared";
import { useAdminToken, useProjects } from "@/lib/admin-client";

const QUICK_LINKS = [
  { href: "/projects", label: "프로젝트 관리", icon: FolderKanban, desc: "생성 · Firebase · 카카오" },
  { href: "/send", label: "푸시 발송", icon: Send, desc: "개인 · 토픽 · 세그먼트 · A/B" },
  { href: "/logs", label: "발송 로그", icon: ScrollText, desc: "상태 · 성공/실패 집계" },
  { href: "/tester", label: "API 테스터", icon: TerminalSquare, desc: "전체 플로우 콘솔" },
];

export default function DashboardPage() {
  const { token, ready } = useAdminToken();
  const { projects, loading } = useProjects(token, ready);

  if (ready && !token) {
    return (
      <div className="space-y-6">
        <PageHeader title="개요" description="Notikit 관리 콘솔" />
        <TokenRequired />
      </div>
    );
  }

  const prod = projects.filter((p) => p.environment === "production").length;

  return (
    <div className="space-y-6">
      <PageHeader title="개요" description="유저 중심 푸시 관리 콘솔" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="프로젝트" value={loading ? "…" : projects.length} />
        <StatCard label="production" value={loading ? "…" : prod} />
        <StatCard label="환경" value={new Set(projects.map((p) => p.environment)).size || 0} hint="dev/staging/prod" />
        <StatCard label="상태" value="log-only" hint="Firebase 미설정 시" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {QUICK_LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href}>
              <Card className="group transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 p-5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-primary">
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

      <Card>
        <CardHeader>
          <CardTitle>프로젝트 ({projects.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects.length === 0 && <p className="text-sm text-muted-foreground">프로젝트가 없습니다. 프로젝트 메뉴에서 생성하세요.</p>}
          {projects.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">{p.apiKey}</p>
              </div>
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
