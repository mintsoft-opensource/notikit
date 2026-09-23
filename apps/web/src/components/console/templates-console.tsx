"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { TemplateFormDialog, type MessageTemplate } from "./template-form";

/** 메시지 템플릿 목록 — 만들고, 고치고, 바로 그 템플릿으로 발송하러 간다 */
export function TemplatesConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("templates");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const [items, setItems] = React.useState<MessageTemplate[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const d = await adminApi<{ templates: MessageTemplate[] }>(`/api/admin/projects/${projectId}/templates`);
      setItems(d.templates);
    } catch {
      setFailed(true);
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  function openEditor(tpl: MessageTemplate | null) {
    setEditing(tpl);
    setOpen(true);
  }

  async function remove(tpl: MessageTemplate) {
    if (!confirm(t("confirmDelete", { name: tpl.name }))) return;
    try {
      await adminApi(`/api/admin/projects/${projectId}/templates/${tpl.id}`, { method: "DELETE" });
      toast.success(t("deleted"));
      await load();
    } catch (e) {
      toast.error(errorText(e, tc("loadFailed")));
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button onClick={() => openEditor(null)}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("newTitle")}
          </Button>
        }
      />

      <TemplateFormDialog
        open={open}
        projectId={projectId}
        editing={editing}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          void load();
        }}
      />

      <Card>
        <CardContent className="p-0">
          {failed && <EmptyState icon={FileText} title={tc("loadFailed")} />}
          {!failed && !items && (
            <div className="space-y-3 p-3.5"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
          )}
          {items && items.length === 0 && <EmptyState icon={FileText} title={t("empty")} />}
          {items && items.length > 0 && (
            <ul className="divide-y divide-border">
              {items.map((tpl) => (
                <li key={tpl.id} className="grid gap-3 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-semibold">{tpl.name}</p>
                      {tpl.fields.length > 0 && <Badge variant="neutral">{t("fieldCount", { count: tpl.fields.length })}</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {[tpl.title, tpl.body].filter(Boolean).join(" · ") || t("noContent")}
                    </p>
                    {tpl.fields.length > 0 && (
                      <p className="truncate font-mono text-2xs text-muted-foreground">
                        {tpl.fields.map((f) => (f.required ? `${f.key}*` : f.key)).join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 justify-self-end">
                    <span className="hidden text-2xs tabular-nums text-muted-foreground lg:inline">{df.format(new Date(tpl.updatedAt))}</span>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/projects/${projectId}/send/single?template=${tpl.id}`}>
                        <Send aria-hidden="true" className="h-3.5 w-3.5" /> {t("useToSend")}
                      </Link>
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`${t("edit")} ${tpl.name}`} onClick={() => openEditor(tpl)}>
                      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`${t("delete")} ${tpl.name}`} onClick={() => remove(tpl)}>
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
