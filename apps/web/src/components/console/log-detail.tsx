"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi } from "@/lib/admin-client";

type Log = {
  id: string;
  type: string;
  target: string | null;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  deepLink: string | null;
  status: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
  readCount: number;
  scheduledAt: string | null;
  variants: Array<{ title: string; body: string }> | null;
  variantStats: Record<string, { sent: number; success: number }> | null;
  kakaoFallback: boolean;
  kakaoCount: number;
  audienceUserCount: number;
  audienceDeviceCount: number;
  clickCount: number;
  clickUserCount: number;
  createdAt: string;
};

type Reader = {
  id: string;
  externalId: string | null;
  platform: string | null;
  destination: string | null;
  clickedAt: string;
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  completed: "success",
  logged: "neutral",
  failed: "danger",
  queued: "warning",
  scheduled: "warning",
  processing: "warning",
};

export function LogDetail({ projectId, logId }: { projectId: string; logId: string }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [log, setLog] = React.useState<Log | null>(null);
  const [readers, setReaders] = React.useState<Reader[] | null>(null);
  const [missing, setMissing] = React.useState(false);

  React.useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const d = await adminApi<{ log: Log }>(`/api/admin/projects/${projectId}/logs/${logId}`);
        if (!stale) setLog(d.log);
      } catch (e) {
        if (stale) return;
        if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
        else toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    })();
    return () => { stale = true; };
  }, [projectId, logId, tc]);

  React.useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const d = await adminApi<{ readers: Reader[] }>(`/api/admin/projects/${projectId}/logs/${logId}/readers`);
        if (!stale) setReaders(d.readers);
      } catch {
        // 읽은 사람 목록은 부가 정보다 — 실패해도 본문 상세는 보여 준다
        if (!stale) setReaders([]);
      }
    })();
    return () => { stale = true; };
  }, [projectId, logId]);

  const backHref = `/projects/${projectId}/logs/${log?.type === "topic" ? "topic" : "single"}`;

  if (missing) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={tc("notFound")} />
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}/logs`}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
        </Button>
      </div>
    );
  }

  if (!log) {
    return <div className="w-full space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  /** 성공률은 분모가 0일 때 0%가 아니라 "—" 다 — 0/0 을 0% 로 쓰면 실패한 발송처럼 읽힌다 */
  const rate = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 1000) / 10}%` : "—");

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={log.title}
        description={`${log.type}${log.target ? ` · ${log.target}` : ""}`}
        actions={
          <Button asChild variant="ghost">
            <Link href={backHref}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("colTitle")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="whitespace-pre-wrap break-words text-sm">{log.body}</p>
            {log.deepLink && (
              <p className="break-all font-mono text-xs text-muted-foreground">{log.deepLink}</p>
            )}
            {log.data && Object.keys(log.data).length > 0 && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-surface-muted p-3 text-2xs text-muted-foreground">
                {JSON.stringify(log.data, null, 2)}
              </pre>
            )}
            {log.variants && log.variants.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                {log.variants.map((v, i) => {
                  const s = log.variantStats?.[String(i)] ?? log.variantStats?.[`v${i}`];
                  return (
                    <div key={i} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{v.title}</span>
                        {s && <Badge variant="neutral">{nf.format(s.success)}/{nf.format(s.sent)}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{v.body}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("colStatus")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-1">
              <DataRow
                label={t("colStatus")}
                value={<Badge variant={STATUS_TONE[log.status] ?? "neutral"}>{log.status}</Badge>}
              />
              <DataRow label={t("colDelivered")} value={`${nf.format(log.successCount)} / ${nf.format(log.totalCount)} (${rate(log.successCount, log.totalCount)})`} />
              <DataRow label={t("colReadRate")} value={`${nf.format(log.readCount)} (${rate(log.readCount, log.successCount)})`} />
              <DataRow label={t("readers")} value={`${nf.format(log.clickUserCount)} / ${nf.format(log.audienceUserCount)} (${rate(log.clickUserCount, log.audienceUserCount)})`} />
              {log.kakaoFallback && <DataRow label="Kakao" value={nf.format(log.kakaoCount)} />}
              {log.scheduledAt && <DataRow label={t("colSentAt")} value={new Date(log.scheduledAt).toLocaleString(locale)} />}
              <DataRow label={tc("createdAt")} value={new Date(log.createdAt).toLocaleString(locale)} />
              <DataRow label="ID" value={log.id} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t("readers")}</CardTitle></CardHeader>
        <CardContent>
          {readers === null && <Skeleton className="h-24 w-full" />}
          {readers?.length === 0 && <p className="text-sm text-muted-foreground">{t("noReaders")}</p>}
          {readers && readers.length > 0 && (
            <div className="space-y-1">
              {readers.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm last:border-b-0">
                  <span className="font-mono text-xs">{r.externalId ?? t("anonymousReader")}</span>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {r.platform && <Badge variant="neutral">{r.platform}</Badge>}
                    <span>{new Date(r.clickedAt).toLocaleString(locale)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
