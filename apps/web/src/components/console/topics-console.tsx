"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Radio, Plus, Trash2, Send } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi } from "@/lib/admin-client";

type Topic = { id: string; name: string; createdAt: string; deviceCount: number; userCount: number };

/** 토픽 목록 — 구독 디바이스/유저 수. 발송 대상은 디바이스지만 "몇 명"은 유저 기준이다. */
export function TopicsConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();

  const [topics, setTopics] = React.useState<Topic[] | null>(null);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ topics: Topic[] }>(`/api/admin/projects/${projectId}/audience/topics`);
      setTopics(d.topics);
    } catch (e) {
      setTopics([]);
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }, [projectId, tc]);

  React.useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      toast.success(t("topicCreated"));
      setName("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc("loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(topic: Topic) {
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics?name=${encodeURIComponent(topic.name)}`, { method: "DELETE" });
      toast.success(t("topicDeleted"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    }
  }

  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("topicsTitle")} description={t("topicsSubtitle")} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("newTopic")}</CardTitle>
            <CardDescription>{t("newTopicHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid items-end gap-3 sm:grid-cols-[minmax(0,24rem)_auto]">
            <Field label={t("topicName")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="news" maxLength={120} spellCheck={false} />
            </Field>
            <Button type="submit" size="sm" className="justify-self-start" disabled={busy || !name.trim()}>
              <Plus aria-hidden="true" className="h-4 w-4" /> {busy ? tc("loading") : t("createTopic")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-none">
        <CardContent className="p-0">
          {!topics && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {topics && topics.length === 0 && <EmptyState icon={Radio} title={t("noTopics")} />}
          {topics && topics.length > 0 && (
            <>
            <div className="hidden gap-x-4 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:grid">
              <span>{t("colTopic")}</span>
              <span>{t("colSubUsers")}</span>
              <span>{t("colSubDevices")}</span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {topics.map((tp) => (
                <li key={tp.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center">
                  <p className="truncate font-mono text-sm font-semibold">{tp.name}</p>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("subscriberUsers", { count: nf.format(tp.userCount) })}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("subscriberDevices", { count: nf.format(tp.deviceCount) })}
                  </span>
                  <div className="flex items-center gap-2 justify-self-end">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/projects/${projectId}/send?type=topic&target=${encodeURIComponent(tp.name)}`}>
                        <Send aria-hidden="true" className="h-3.5 w-3.5" /> {t("sendToTopic")}
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`${t("deleteTopic")} ${tp.name}`}
                      onClick={() => remove(tp)}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
