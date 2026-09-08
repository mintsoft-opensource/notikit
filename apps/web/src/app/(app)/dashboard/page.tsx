"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FolderKanban, Activity, ArrowRight, Rocket, Layers, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile icon={Rocket} label={t("production")} value={prod} loading={loading} accent="primary" />
        <StatTile icon={Layers} label={t("environments")} value={new Set(projects.map((p) => p.environment)).size || 0} hint={t("envHint")} />
        <StatTile icon={ShieldCheck} label={t("status")} value={t("logOnly")} hint={t("logOnlyHint")} accent="muted" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {quickLinks.map((l) => {
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
          <CardTitle>{t("projectsCount", { count: projects.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects.length === 0 && <p className="text-sm text-muted-foreground">{t("noProjects")}</p>}
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="flex items-center justify-between rounded-lg border border-border px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface-muted"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">{p.apiKey}</p>
              </div>
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
