"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { LiveChart } from "@/components/system/live-chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/ui/eyebrow";
import { cursorQuery, type Cursor } from "@/lib/cursor-query";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { useNumberFormat } from "@/lib/number-format";

type Reader = {
  id: string;
  externalId: string | null;
  platform: string | null;
  destination: string | null;
  clickedAt: string;
};


type ReadPoint = { ts: string; count: number; cumulative: number };
type ReadersResponse = { readers: Reader[]; series: ReadPoint[]; bucket: "hour" | "day" | "week"; next: Cursor };

/**
 * 이 발송을 읽은(알림을 누른) 사람 — 시간순 추이 + 전체 표.
 * 펼칠 때 처음 한 번만 불러온다. 목록 50건의 수신자를 미리 다 받으면 로그 화면이 느려진다.
 */
export function ReaderDetail({ projectId, logId }: { projectId: string; logId: string }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();
  const [data, setData] = React.useState<ReadersResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [more, setMore] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    adminApi<ReadersResponse>(`/api/admin/projects/${projectId}/logs/${logId}/readers`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [projectId, logId]);

  async function loadMore() {
    if (!data?.next || more) return;
    setMore(true);
    try {
      const d = await adminApi<ReadersResponse>(
        `/api/admin/projects/${projectId}/logs/${logId}/readers?${cursorQuery(data.next)}`
      );
      setData((cur) => (cur ? { ...cur, readers: [...cur.readers, ...d.readers], next: d.next } : cur));
    } catch (e) {
      toast.error(errorText(e, t("loadFailed")));
    } finally {
      setMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = useNumberFormat();
  const bucketFmt = React.useMemo(
    () =>
      data?.bucket === "day"
        ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
        : new Intl.DateTimeFormat(locale, { hour: "numeric" }),
    [locale, data?.bucket]
  );

  if (failed) return <p className="border-t border-border px-3.5 py-2.5 text-sm text-muted-foreground">{t("loadFailed")}</p>;
  if (!data) {
    return (
      <div className="space-y-2 border-t border-border px-3.5 py-2.5">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t border-border bg-surface-muted/20 px-3.5 py-2.5">
      <section>
        <Eyebrow as="h4" className="mb-2">{t("readTrend")}</Eyebrow>
        {data.series.some((p) => p.count > 0) ? (
          <LiveChart
            label={t("readTrend")}
            integerY
            area
            height={140}
            times={data.series.map((p) => new Date(p.ts).getTime())}
            formatY={(v) => nf.format(Math.round(v))}
            formatTime={(ms) => bucketFmt.format(ms)}
            series={[
              { key: "reads", label: t("readsPerBucket"), color: "var(--chart-2)", values: data.series.map((p) => p.count) },
              { key: "cumulative", label: t("readsCumulative"), color: "var(--chart-1)", values: data.series.map((p) => p.cumulative) },
            ]}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("noReaders")}</p>
        )}
      </section>

      <section>
        <Eyebrow as="h4" className="mb-2">{t("readerTable", { count: nf.format(data.readers.length) })}</Eyebrow>
        {data.readers.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("noReaders")}</p>
        ) : (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[36rem] text-start">
              <thead className="border-b border-border">
                <tr className="bg-surface-muted/50 text-xs font-semibold text-muted-foreground">
                  <th scope="col" className="px-3.5 py-2.5">{t("colUser")}</th>
                  <th scope="col" className="px-3.5 py-2.5">{t("colPlatform")}</th>
                  <th scope="col" className="px-3.5 py-2.5">{t("colDestination")}</th>
                  <th scope="col" className="px-3.5 py-2.5 text-end">{t("colReadAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.readers.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-0 truncate px-3.5 py-2.5 font-mono text-xs font-semibold">
                      {r.externalId ?? <span className="font-sans font-normal text-muted-foreground">{t("anonymousReader")}</span>}
                    </td>
                    <td className="px-3.5 py-2.5 text-xs text-muted-foreground">{r.platform ?? "—"}</td>
                    <td className="max-w-0 truncate px-3.5 py-2.5 text-xs text-muted-foreground">{r.destination ?? "—"}</td>
                    <td className="whitespace-nowrap px-3.5 py-2.5 text-end text-xs tabular-nums text-muted-foreground">
                      <time dateTime={r.clickedAt}>{df.format(new Date(r.clickedAt))}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.next && (
              <div className="flex justify-center border-t border-border p-2">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={more}>
                  {more ? tc("loading") : tc("loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
