"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Trash2, Send } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi } from "@/lib/admin-client";

type Topic = { id: string; name: string; createdAt: string };

export function TopicDetail({ projectId, topicId }: { projectId: string; topicId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [data, setData] = React.useState<{ topic: Topic; deviceCount: number; userCount: number } | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const d = await adminApi<{ topic: Topic; deviceCount: number; userCount: number }>(
          `/api/admin/projects/${projectId}/audience/topics/${topicId}`
        );
        if (!stale) setData(d);
      } catch (e) {
        if (stale) return;
        if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
        else toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    })();
    return () => { stale = true; };
  }, [projectId, topicId, tc]);

  async function remove() {
    if (!data) return;
    // 구독자가 있으면 몇 명이 끊기는지 보여 준 뒤 묻는다
    const msg = data.deviceCount > 0
      ? t("confirmDeleteTopicWithSubs", { name: data.topic.name, count: nf.format(data.deviceCount) })
      : tc("confirmRemove");
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics/${topicId}`, { method: "DELETE" });
      toast.success(tc("removed"));
      router.push(`/projects/${projectId}/topics`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("removeFailed"));
      setBusy(false);
    }
  }

  const backHref = `/projects/${projectId}/topics`;

  if (missing) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={tc("notFound")} />
        <Button asChild variant="outline">
          <Link href={backHref}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
        </Button>
      </div>
    );
  }

  if (!data) {
    return <div className="w-full space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /></div>;
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={data.topic.name}
        description={t("topicsSubtitle")}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href={backHref}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/projects/${projectId}/send?type=topic&target=${encodeURIComponent(data.topic.name)}`}>
                <Send aria-hidden="true" className="h-4 w-4" /> {t("sendToTopic")}
              </Link>
            </Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>
              <Trash2 aria-hidden="true" className="h-4 w-4" /> {tc("remove")}
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="space-y-1 pt-3.5">
          <DataRow label={t("colSubUsers")} value={nf.format(data.userCount)} />
          <DataRow label={t("colSubDevices")} value={nf.format(data.deviceCount)} />
          <DataRow label="ID" value={data.topic.id} />
          <DataRow label={tc("createdAt")} value={new Date(data.topic.createdAt).toLocaleString()} />
        </CardContent>
      </Card>
    </div>
  );
}
