"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { BellOff, Clock, Send } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import type { AudienceEstimate } from "./send-estimate";
import type { SendWarning } from "./send-rules";
import { SendWarnings } from "./send-summary";

/**
 * 발송 전 마지막 확인. 전체 발송의 confirm() 과 "즉시 처리" 체크박스를 여기로 모았다 —
 * 어떤 방식이든 이 창의 최종 버튼을 눌러야만 나간다.
 */
export function SendReviewDialog({
  open,
  onClose,
  onConfirm,
  sending,
  targetLabel,
  estimate,
  isScheduled,
  timeLabel,
  title,
  body,
  imageUrl,
  warnings,
  variants,
  silent,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (processNow: boolean) => void;
  sending: boolean;
  targetLabel: string;
  estimate: AudienceEstimate | null;
  isScheduled: boolean;
  timeLabel: string;
  title: string;
  body: string;
  imageUrl: string | null;
  warnings: SendWarning[];
  /** A/B 변형(치환 후, 0번이 기본 내용). 둘 이상이면 변형별로 보여 준다 */
  variants?: Array<{ title: string; body: string }>;
  /** 무음 푸시 — 제목·본문이 표시되지 않으므로 내용 대신 그 사실을 확인시킨다 */
  silent?: boolean;
  actions?: Array<{ id: string; title: string; deep_link?: string }>;
}) {
  const t = useTranslations("send");
  const [processNow, setProcessNow] = React.useState(true);
  const checkboxId = React.useId();

  React.useEffect(() => {
    if (open) setProcessNow(true);
  }, [open]);

  const confirmLabel = isScheduled
    ? t("reviewConfirmSchedule")
    : estimate
      ? t("reviewConfirm", { count: estimate.users })
      : t("submit");

  return (
    <Dialog
      open={open}
      onClose={sending ? () => {} : onClose}
      title={t("reviewTitle")}
      description={t("reviewDescription")}
      size="lg"
      initialFocus="dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sending}>{t("reviewBack")}</Button>
          <Button onClick={() => onConfirm(processNow && !isScheduled)} disabled={sending}>
            {isScheduled ? <Clock aria-hidden="true" /> : <Send aria-hidden="true" />}
            {sending ? t("sending") : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="divide-y divide-border rounded-lg border border-border text-sm">
          <ReviewRow label={t("sectionTarget")} value={targetLabel} />
          <ReviewRow
            label={t("reviewAudience")}
            value={estimate ? t("actionAudience", { users: estimate.users, devices: estimate.devices }) : "—"}
          />
          <ReviewRow label={t("summaryTime")} value={timeLabel} />
        </dl>

        <div className="flex gap-3 rounded-lg border border-border bg-surface-muted/40 p-3.5">
          <div className="min-w-0 flex-1 space-y-1">
            <Eyebrow>{t("sectionContent")}</Eyebrow>
            {silent ? (
              <p className="flex items-start gap-2 text-sm text-foreground/80">
                <BellOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{t("reviewSilent")}</span>
              </p>
            ) : variants && variants.length > 1 ? (
              <ul className="space-y-2" aria-label={t("reviewVariants", { count: variants.length })}>
                {variants.map((v, i) => (
                  <li key={i} className="space-y-0.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <p className="text-xs font-semibold text-primary">{t("variantName", { letter: String.fromCharCode(65 + i) })}</p>
                    <p className="break-words text-sm font-semibold">{v.title}</p>
                    <p className="whitespace-pre-line break-words text-sm text-foreground/80">{v.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="break-words text-sm font-semibold">{title}</p>
                <p className="whitespace-pre-line break-words text-sm text-foreground/80">{body}</p>
              </>
            )}
          </div>
          {imageUrl && !silent && (
            <img src={imageUrl} alt={t("imagePreviewAlt")} className="h-16 w-16 shrink-0 rounded-lg border border-border object-cover" />
          )}
        </div>

        {actions && actions.length > 0 && (
          <div className="space-y-1">
            <Eyebrow>{t("optActions")}</Eyebrow>
            <ul aria-label={t("optActions")} className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <li key={a.id} className="inline-flex h-7 max-w-full items-center rounded-lg border border-border px-2.5 text-xs font-semibold">
                  <span className="truncate">{a.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <SendWarnings warnings={warnings} compact />

        <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm leading-relaxed">
          <input
            id={checkboxId}
            type="checkbox"
            checked={processNow && !isScheduled}
            disabled={isScheduled || sending}
            onChange={(e) => setProcessNow(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
          />
          <span className={isScheduled ? "text-muted-foreground" : undefined}>
            {isScheduled ? t("processNowDisabled") : t("processNow")}
          </span>
        </label>
      </div>
    </Dialog>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-end font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
