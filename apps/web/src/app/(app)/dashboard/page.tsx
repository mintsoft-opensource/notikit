"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FolderKanban, Activity, ArrowRight, Rocket, Layers, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { useProjects } from "@/lib/admin-client";

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const { projects, loading } = useProjects();
  const prod = projects.filter((p) => p.environment === "production").length;

  const quickLinks = [
    { href: "/projects", label: t("quickProjects"), icon: FolderKanban, desc: t("quickProjectsDesc") },
    { href: "/system", label: t("quickSystem"), icon: Activity, desc: t("quickSystemDesc") },
  ];

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <StatTile icon={Rocket} label={t("production")} value={prod} loading={loading} accent="primary" />
        <StatTile icon={Layers} label={t("environments")} value={new Set(projects.map((p) => p.environment)).size || 0} hint={t("envHint")} loading={loading} />
        <StatTile icon={ShieldCheck} label={t("status")} value={t("logOnly")} hint={t("logOnlyHint")} accent="muted" />
        <div className="grid gap-3 sm:col-span-3 sm:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
          {quickLinks.map((l) => {
            const Icon = l.icon;
            return (
              <Link key={l.href} href={l.href}>
                <Card className="group h-full transition-colors hover:border-primary/40 hover:bg-accent-soft/40">
                  <CardContent className="flex items-center gap-3 p-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-accent-soft text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
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

      <Card>
        <CardHeader>
          <CardTitle>{t("projectsCount", { count: projects.length })}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {loading && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-20 rounded-tile" />)}
          {!loading && projects.length === 0 && (
            <EmptyState className="lg:col-span-2" icon={FolderKanban} title={t("noProjects")} description={t("quickProjectsDesc")} action={<Button asChild size="sm"><Link href="/projects">{t("quickProjects")}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link></Button>} />
          )}
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-tile border border-border px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface-muted"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="truncate font-mono text-2xs text-muted-foreground">{p.apiKey}</p>
              </div>
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
