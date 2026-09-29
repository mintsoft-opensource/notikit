"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataRow } from "@/components/ui/data-row";
import { adminApi } from "@/lib/admin-client";
import { StatusChip } from "./log-status";
import { useNumberFormat } from "@/lib/number-format";

/** 발송 뒤 하단에 남기는 결과 — 토스트는 사라지므로 확인할 수 있게 화면에 붙여둔다 */
export type SendResult = {
  status: "queued" | "scheduled" | "processed" | "processFailed" | "failed";
  messageId?: string;
  scheduledAt?: string | null;
  error?: string;
};

type MessageState = {
  status: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
};

const POLL_MS = 2000;
const MAX_POLLS = 15;
// 취소도 끝난 상태다 — 빠지면 취소된 발송을 폴링 한도까지 계속 따라간다
const SETTLED = new Set(["completed", "failed", "logged", "scheduled", "canceled"]);

/**
 * 이 메시지 ID 의 실제 상태. "큐 처리 요청이 성공했다"는 다른 발송까지 섞인 결과라
 * 이 메시지가 나갔는지 알려 주지 않는다 — 로그 행을 직접 읽고, 끝날 때까지 잠시 따라간다.
 */
function useMessageState(projectId: string, messageId: string | undefined, attempt: number) {
  const [state, setState] = React.useState<MessageState | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!messageId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    setFailed(false);

    const tick = async () => {
      try {
        const d = await adminApi<{ log: MessageState }>(`/api/admin/projects/${projectId}/logs/${messageId}`);
        if (!alive) return;
        setState(d.log);
        polls += 1;
        if (!SETTLED.has(d.log.status) && polls < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
      } catch {
        if (alive) setFailed(true);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, messageId, attempt]);

  return { state, failed };
}

export function SendResultCard({ projectId, result }: { projectId: string; result: SendResult }) {
  const t = useTranslations("send");
  const tl = useTranslations("logs");
  const locale = useLocale();
  const nf = useNumberFormat();
  const [attempt, setAttempt] = React.useState(0);
  const { state, failed } = useMessageState(projectId, result.messageId, attempt);

  const requestFailed = result.status === "failed";
  const messageFailed = state?.status === "failed";
  const warn = result.status === "processFailed" || messageFailed;
  const stateKey = state ? `status_${state.status}` : null;
  const stateLabel = stateKey ? (tl.has(stateKey) ? tl(stateKey as "status_queued") : state?.status) : failed ? t("resultStateUnknown") : "";
  const announcement = result.messageId && stateLabel ? `${t("resultMessageState")}: ${stateLabel}` : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {requestFailed || warn ? (
            <AlertTriangle aria-hidden="true" className={`size-4 ${requestFailed || messageFailed ? "text-error" : "text-warning"}`} />
          ) : result.status === "scheduled" ? (
            <Clock aria-hidden="true" className="size-4 text-primary" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          )}
          {t("resultTitle")}
        </CardTitle>
        {result.messageId && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw aria-hidden="true" className="size-4" /> {t("resultRefresh")}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/logs/${result.messageId}`}>
                <ExternalLink aria-hidden="true" className="size-4" /> {t("resultOpenLog")}
              </Link>
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {/* 토스트는 사라지지만 메시지 ID 는 로그 대조에 필요하다 — 화면에 남긴다 */}
        <p role="status" className="sr-only">{announcement}</p>
        <dl className="space-y-2 [&_dd]:min-w-0 [&_dd]:break-all">
          <DataRow
            label={t("resultStatus")}
            value={
              requestFailed ? t("resultFailed")
                : result.status === "processFailed" ? t("resultProcessFailed")
                : result.status === "processed" ? t("resultProcessed")
                : result.status === "scheduled" ? t("resultScheduled")
                : t("resultQueued")
            }
            tone={requestFailed ? "danger" : result.status === "processFailed" ? "warning" : "default"}
          />
          {result.messageId && (
            <DataRow
              label={t("resultMessageState")}
              value={state ? <StatusChip status={state.status} /> : failed ? t("resultStateUnknown") : "…"}
            />
          )}
          {state && state.totalCount > 0 && (
            <DataRow
              label={t("resultDelivered")}
              value={t("resultDeliveredValue", {
                success: nf.format(state.successCount),
                failure: nf.format(state.failureCount),
                total: nf.format(state.totalCount),
              })}
            />
          )}
          {result.messageId && <DataRow label={t("resultMessageId")} value={result.messageId} mono />}
          {result.scheduledAt && <DataRow label={t("resultScheduledAt")} value={new Date(result.scheduledAt).toLocaleString(locale)} />}
          {result.error && <DataRow label={t("sendFailed")} value={result.error} />}
        </dl>
      </CardContent>
    </Card>
  );
}
