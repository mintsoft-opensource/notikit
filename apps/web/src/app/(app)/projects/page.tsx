"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Copy, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi } from "@/lib/admin-client";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const { projects, reload } = useProjects();
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
    <div className="mx-auto w-full max-w-[1200px] space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("newProject")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-project-name">{t("nameLabel")}</Label>
            <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </div>
          <div className="space-y-1">
            <Label>{t("envLabel")}</Label>
            <Select aria-label={t("envLabel")} value={environment} onChange={(e) => setEnvironment(e.target.value)} className="sm:w-40">
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </Select>
          </div>
          <Button onClick={create} disabled={creating || !name.trim()} className="shrink-0">
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("create")}
          </Button>
        </CardContent>
      </Card>

      {secret && (
        <Card className="border-primary/40">
          <CardContent className="space-y-2 p-5">
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

      <div className="space-y-2">
        {projects.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface-muted"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{p.name}</span>
                <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
                {p.hasFirebase ? <Badge variant="success">Firebase</Badge> : <Badge variant="neutral">log-only</Badge>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{p.apiKey}</p>
            </div>
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}
