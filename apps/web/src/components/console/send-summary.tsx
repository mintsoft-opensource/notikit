"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow } from "@/components/ui/eyebrow";
import { cn } from "@/lib/utils";
import type { AudienceEstimate } from "./send-estimate";
import { BODY_RECOMMENDED, TITLE_RECOMMENDED, platformEntries, type SendWarning } from "./send-rules";

const PLATFORM_LABEL: Record<string, string> = { ios: "iOS", android: "Android", web: "Web" };
const PLATFORM_COLOR: Record<string, string> = { ios: "bg-chart-4", android: "bg-chart-1", web: "bg-chart-2" };

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p] ?? p;
}

/** 오른쪽 고정 열의 요약 — 누구에게(추정 인원)·언제·무엇을 조심할지를 보내기 전에 한 곳에서 본다 */
export function SendSummary({
  estimate,
  loading,
  failed,
  hasRequest,
  timeLabel,
  warnings,
}: {
  estimate: AudienceEstimate | null;
  loading: boolean;
  failed: boolean;
  hasRequest: boolean;
  timeLabel: string;
  warnings: SendWarning[];
}) {
  const t = useTranslations("send");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const headingId = React.useId();
  const platforms = estimate ? platformEntries(estimate.platforms) : [];
  const platformTotal = platforms.reduce((sum, [, n]) => sum + n, 0);

  return (
    <Card>
      <section aria-labelledby={headingId}>
        <CardHeader className="items-center">
          <CardTitle id={headingId}>{t("summaryTitle")}</CardTitle>
          {loading && hasRequest && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> {t("summaryEstimating")}
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className={cn("grid grid-cols-2 gap-2 transition-opacity", loading && estimate && "opacity-60")}>
            <Stat label={t("summaryUsers")} value={estimate ? nf.format(estimate.users) : "—"} />
            <Stat label={t("summaryDevices")} value={estimate ? nf.format(estimate.devices) : "—"} />
          </dl>

          {!hasRequest && <p className="text-xs text-muted-foreground">{t("summaryPickTarget")}</p>}
          {failed && <p className="text-xs text-error">{t("summaryEstimateFailed")}</p>}

          {estimate && platformTotal > 0 && (
            <div className="space-y-2">
              <Eyebrow>{t("summaryPlatforms")}</Eyebrow>
              <div aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-full bg-surface-muted">
                {platforms.map(([p, n]) => (
                  <span key={p} className={cn("h-full", PLATFORM_COLOR[p] ?? "bg-chart-3")} style={{ width: `${(n / platformTotal) * 100}%` }} />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {platforms.map(([p, n]) => (
                  <li key={p} className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", PLATFORM_COLOR[p] ?? "bg-chart-3")} />
                    <span className="text-muted-foreground">{p === "other" ? t("platformOther") : platformLabel(p)}</span>
                    <span className="font-semibold tabular-nums">{nf.format(n)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-lg bg-surface-muted/60 px-3.5 py-2.5 text-xs">
            <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{t("summaryTime")}</span>
            <span className="ms-auto font-semibold tabular-nums">{timeLabel}</span>
          </div>

          <SendWarnings warnings={warnings} />
          <p className="text-xs leading-relaxed text-muted-foreground">{t("helpSuppression")}</p>
        </CardContent>
      </section>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-3.5 py-2.5">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-bold tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

/**
 * 경고 목록 — 요약 카드와 검토 다이얼로그가 같은 문구를 쓴다.
 *
 * 요약 카드 쪽은 입력에 따라 경고가 조용히 늘고 준다. 화면을 보지 않는 사용자는
 * "제목이 깁니다" 가 붙은 걸 알 수 없으므로 polite 영역으로 감싸 읽어 준다(WCAG 4.1.3).
 * 감싸는 div 는 경고가 없을 때도 **남아 있어야** 한다 — live 영역이 통째로 생겼다
 * 사라지면 브라우저가 변경으로 보지 않아 아무것도 읽히지 않는다.
 * compact(검토 다이얼로그)는 열린 순간의 정지된 내용이라 live 로 만들지 않는다 —
 * 다이얼로그 본문으로 이미 읽히는 것을 두 번 말하게 된다.
 */
export function SendWarnings({ warnings, compact }: { warnings: SendWarning[]; compact?: boolean }) {
  const t = useTranslations("send");
  const text = useWarningText();
  const body =
    warnings.length === 0 ? (
      compact ? null : (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" /> {t("summaryNoWarnings")}
        </p>
      )
    ) : (
      <ul aria-label={t("summaryWarnings")} className="space-y-1.5">
        {warnings.map((w) => (
          <li key={w} className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
            <AlertTriangle aria-hidden="true" className="mt-px h-4 w-4 shrink-0" />
            <span>{text(w)}</span>
          </li>
        ))}
      </ul>
    );

  if (compact) return body;
  return (
    <div aria-live="polite" aria-atomic="true">
      {body}
    </div>
  );
}

export function useWarningText() {
  const t = useTranslations("send");
  return (w: SendWarning): string => {
    switch (w) {
      case "titleLong": return t("warnTitleLong", { max: TITLE_RECOMMENDED });
      case "bodyLong": return t("warnBodyLong", { max: BODY_RECOMMENDED });
      case "imageNotHttps": return t("imageNotHttps");
      case "imageInvalid": return t("imageInvalid");
      case "noDevices": return t("warnNoDevices");
      case "broadcast": return t("warnBroadcast");
      case "logOnly": return t("helpLogOnly");
    }
  };
}
