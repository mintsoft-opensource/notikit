"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Copy, ChevronRight, FolderKanban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi } from "@/lib/admin-client";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const ts = useTranslations("settings");
  const { projects, loading, reload } = useProjects();
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState("dev");
  const [secret, setSecret] = React.useState<{ key: string; secret: string } | null>(null);
  const [creating, setCreating] = React.useState(false);

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const d = await adminApi<{ project: { apiKey: string }; api_secret: string }>("/api/admin/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), environment }),
      });
      setSecret({ key: d.project.apiKey, secret: d.api_secret });
      setName("");
      toast.success(t("created"));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("createFailed"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("newProject")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-project-name">{t("nameLabel")}</Label>
            <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </div>
          <div className="space-y-1">
            <Label>{t("envLabel")}</Label>
            <Select aria-label={t("envLabel")} value={environment} onChange={(e) => setEnvironment(e.target.value)} className="w-full">
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </Select>
          </div>
          <Button onClick={create} disabled={creating || !name.trim()} className="sm:col-span-2 sm:justify-self-end xl:col-span-1">
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("create")}
          </Button>
        </CardContent>
      </Card>

      {secret && (
        <Card className="border-primary/40">
          <CardContent className="space-y-2 p-3.5">
            <p className="text-sm font-bold text-primary">{t("secretNotice")}</p>
            <div className="space-y-1 font-mono text-xs">
              <button
                className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-left"
                onClick={async () => { try { await navigator.clipboard.writeText(secret.key); toast.success(t("apiKeyCopied")); } catch { toast.error(t("copyFailedManual")); } }}
              >
                <span className="truncate">api_key: {secret.key}</span> <Copy aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </button>
              <button
                className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-left"
                onClick={async () => { try { await navigator.clipboard.writeText(secret.secret); toast.success(t("apiSecretCopied")); } catch { toast.error(t("copyFailedManual")); } }}
              >
                <span className="truncate">api_secret: {secret.secret}</span> <Copy aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>{t("close")}</Button>
          </CardContent>
        </Card>
      )}

      <div className="overflow-hidden border border-border bg-surface shadow-card">
        {loading && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
        {!loading && projects.length === 0 && <EmptyState icon={FolderKanban} title={t("empty")} description={t("subtitle")} action={<Button size="sm" variant="outline" onClick={() => document.getElementById("new-project-name")?.focus()}><Plus aria-hidden="true" className="h-4 w-4" />{t("newProject")}</Button>} />}
        {projects.length > 0 && <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_1rem] gap-3 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground lg:grid"><span>{t("nameLabel")}</span><span>{ts("apiKeyLabel")}</span><span>{t("envLabel")}</span><span /></div>}
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border px-3.5 py-2.5 transition-colors last:border-b-0 hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_1rem]"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-tile bg-accent-soft text-primary"><FolderKanban aria-hidden="true" className="h-4 w-4" /></span>
              <span className="truncate text-sm font-semibold">{p.name}</span>
            </div>
            <p className="col-start-1 row-start-2 truncate font-mono text-xs text-muted-foreground lg:col-start-auto lg:row-start-auto">{p.apiKey}</p>
            <div className="col-start-1 flex flex-wrap items-center gap-2 lg:col-start-auto">
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
              {p.hasFirebase ? <Badge variant="success">Firebase</Badge> : <Badge variant="neutral">log-only</Badge>}
            </div>
            <ChevronRight aria-hidden="true" className="col-start-2 row-start-1 h-4 w-4 shrink-0 text-muted-foreground lg:col-start-4" />
          </Link>
        ))}
      </div>
    </div>
  );
}
