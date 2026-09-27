"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/segmented";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/number-format";

type DeliveryStatus = "pending" | "delivered" | "failed";
type Filter = "all" | DeliveryStatus;

type Delivery = {
  id: string;
  event: string;
  status: DeliveryStatus | string;
  attempts: number;
  lastStatusCode: number | null;
  createdAt: string;
};

type Cursor = { ts: string; id: string } | null;
type Page = { deliveries: Delivery[]; next: Cursor };

const STATUS_BADGE: Record<DeliveryStatus, "success" | "danger" | "warning"> = {
  delivered: "success",
  failed: "danger",
  pending: "warning",
};

/**
 * 웹훅 한 개의 배달 이력 — 펼쳤을 때만 불러온다. 목록을 열 때마다 모든 웹훅의
 * 이력을 읽으면 웹훅 수만큼 요청이 나간다.
 */
export function WebhookDeliveries({ projectId, webhookId }: { projectId: string; webhookId: string }) {
  const t = useTranslations("webhooks");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();
  const panelId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [rows, setRows] = React.useState<Delivery[] | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const genRef = React.useRef(0);

  const baseUrl = `/api/admin/projects/${projectId}/webhooks/${webhookId}/deliveries`;
  const query = React.useCallback(
    (cursor: Cursor) => {
      const q = new URLSearchParams();
      if (filter !== "all") q.set("status", filter);
      if (cursor) {
        q.set("before", cursor.ts);
        q.set("before_id", cursor.id);
      }
      const s = q.toString();
      return s ? `${baseUrl}?${s}` : baseUrl;
    },
    [baseUrl, filter]
  );

  React.useEffect(() => {
    if (!open) return;
    const my = ++genRef.current;
    setRows(null);
    setNext(null);
    setError(null);
    setLoadingMore(false);
    adminApi<Page>(query(null))
      .then((d) => {
        if (my !== genRef.current) return;
        setRows(d.deliveries);
        setNext(d.next);
      })
      .catch((e) => {
        if (my === genRef.current) setError(errorText(e, tc("loadFailed")));
      });
    return () => { genRef.current++; };
  }, [open, query, attempt, errorText, tc]);

  async function loadMore() {
    if (!next || loadingMore) return;
    const my = genRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<Page>(query(next));
      if (my !== genRef.current) return;
      setRows((cur) => [...(cur ?? []), ...d.deliveries]);
      setNext(d.next);
    } catch (e) {
      if (my === genRef.current) setError(errorText(e, tc("loadFailed")));
    } finally {
      if (my === genRef.current) setLoadingMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);
  const nf = useNumberFormat();

  return (
    <div className="mt-2 border-t border-border pt-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <History aria-hidden="true" className="size-4" />
        {t("deliveriesToggle")}
        <ChevronDown aria-hidden="true" className={cn("size-4 motion-safe:transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <div id={panelId} className="mt-2 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Filter>
              label={t("deliveriesFilter")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("deliveriesAll") },
                { value: "delivered", label: t("deliveryStatus_delivered") },
                { value: "failed", label: t("deliveryStatus_failed") },
                { value: "pending", label: t("deliveryStatus_pending") },
              ]}
            />
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw aria-hidden="true" className="size-4" /> {t("deliveriesRefresh")}
            </Button>
          </div>

          {error && <p role="alert" className="text-sm text-error">{error}</p>}
          {!error && rows === null && (
            <div role="status">
              <span className="sr-only">{tc("loading")}</span>
              <Skeleton aria-hidden="true" className="h-24 w-full" />
            </div>
          )}
          {rows?.length === 0 && <p className="text-sm text-muted-foreground">{t("deliveriesEmpty")}</p>}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("deliveriesCaption")}</caption>
                <thead>
                  <tr className="border-b border-border text-start text-2xs text-muted-foreground">
                    <th scope="col" className="py-1.5 pe-3 text-start font-semibold">{t("deliveryColTime")}</th>
                    <th scope="col" className="py-1.5 pe-3 text-start font-semibold">{t("deliveryColEvent")}</th>
                    <th scope="col" className="py-1.5 pe-3 text-start font-semibold">{t("deliveryColStatus")}</th>
                    <th scope="col" className="py-1.5 pe-3 text-end font-semibold">{t("deliveryColCode")}</th>
                    <th scope="col" className="py-1.5 text-end font-semibold">{t("deliveryColAttempts")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const known = Object.hasOwn(STATUS_BADGE, d.status);
                    return (
                      <tr key={d.id} className="border-b border-border last:border-b-0">
                        <td className="whitespace-nowrap py-2 pe-3 tabular-nums text-muted-foreground">{df.format(new Date(d.createdAt))}</td>
                        <td className="py-2 pe-3 font-mono text-xs">{d.event}</td>
                        <td className="py-2 pe-3">
                          <Badge variant={known ? STATUS_BADGE[d.status as DeliveryStatus] : "neutral"}>
                            {known ? t(`deliveryStatus_${d.status as DeliveryStatus}`) : d.status}
                          </Badge>
                        </td>
                        <td className="py-2 pe-3 text-end font-mono tabular-nums">{d.lastStatusCode ?? "—"}</td>
                        <td className="py-2 text-end tabular-nums">{nf.format(d.attempts)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {next && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? tc("loading") : tc("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
