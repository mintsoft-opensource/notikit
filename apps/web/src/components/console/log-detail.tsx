"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, RefreshCw, ScrollText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { AdminApiError, adminApi, useAdminErrorText } from "@/lib/admin-client";
import { RateBar, StatusChip, TestChip } from "./log-status";
import { AB_MIN_VARIANT_SAMPLE, AB_TIE_MARGIN, type AbTest, type AbVariantResult } from "@/lib/ab-test";

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
  /** A/B 자동 승자 — 표본 발송이면 설정·판정, 승자 본발송이면 어느 발송의 어떤 변형인지 */
  abTest?: AbTest | null;
  kakaoFallback: boolean;
  kakaoCount: number;
  audienceUserCount: number;
  audienceDeviceCount: number;
  clickCount: number;
  clickUserCount: number;
  createdAt: string;
  isTest?: boolean;
  imageUrl?: string | null;
  /** 토큰별 실패 사유 → 건수. 발송이 끝난 뒤에만 채워진다 */
  deliveryErrors?: Record<string, number> | null;
  /** 콘솔 발송이면 멤버 이메일, API 발송이면 "api". 기록 이전 로그는 null */
  sentBy?: string | null;
};

/** 변형별 클릭 — variant 가 null 인 행은 변형 없이 나간 발송의 클릭이다 */
type VariantClicks = { byVariant: Array<{ variant: number | null; clicks: number }> };

type Conversions = {
  count: number;
  /** 최소 화폐 단위 합계(원·센트). 화면이 단위를 밝힌다 */
  valueCents: number;
  byName: Array<{ name: string; count: number; valueCents: number }>;
};

type LogDetailResponse = { log: Log; clicks?: VariantClicks; conversions?: Conversions };

type Reader = {
  id: string;
  externalId: string | null;
  platform: string | null;
  destination: string | null;
  clickedAt: string;
};

/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;
type ReadersPage = { readers: Reader[]; next: Cursor };

export function LogDetail({ projectId, logId }: { projectId: string; logId: string }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const errorText = useAdminErrorText();

  const [log, setLog] = React.useState<Log | null>(null);
  const [variantClicks, setVariantClicks] = React.useState<VariantClicks | null>(null);
  const [conversions, setConversions] = React.useState<Conversions | null>(null);
  const [readers, setReaders] = React.useState<Reader[] | null>(null);
  const [readersNext, setReadersNext] = React.useState<Cursor>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [missing, setMissing] = React.useState(false);
  // 404 가 아닌 실패 — 스켈레톤을 계속 돌리면 기다리면 될 것처럼 보인다
  const [failed, setFailed] = React.useState(false);
  // "다시 시도"가 올리는 숫자 — 두 요청을 같이 다시 보낸다
  const [attempt, setAttempt] = React.useState(0);
  // 읽은 사람 요청 세대 — 다시 시도 뒤 늦게 온 "더 보기" 응답이 새 목록에 붙지 않게
  const readersGenRef = React.useRef(0);

  React.useEffect(() => {
    let stale = false;
    setLog(null);
    setVariantClicks(null);
    setConversions(null);
    setMissing(false);
    setFailed(false);
    (async () => {
      try {
        const d = await adminApi<LogDetailResponse>(`/api/admin/projects/${projectId}/logs/${logId}`);
        if (stale) return;
        setLog(d.log);
        setVariantClicks(d.clicks ?? null);
        setConversions(d.conversions ?? null);
      } catch (e) {
        if (stale) return;
        if (e instanceof AdminApiError && e.status === 404) return setMissing(true);
        setFailed(true);
        toast.error(errorText(e, tc("loadFailed")));
      }
    })();
    return () => { stale = true; };
  }, [projectId, logId, attempt, tc, errorText]);

  React.useEffect(() => {
    const my = ++readersGenRef.current;
    setReaders(null);
    setReadersNext(null);
    setLoadingMore(false);
    (async () => {
      try {
        const d = await adminApi<ReadersPage>(`/api/admin/projects/${projectId}/logs/${logId}/readers`);
        if (my !== readersGenRef.current) return;
        setReaders(d.readers);
        setReadersNext(d.next);
      } catch {
        // 읽은 사람 목록은 부가 정보다 — 실패해도 본문 상세는 보여 준다
        if (my === readersGenRef.current) setReaders([]);
      }
    })();
    return () => { readersGenRef.current++; };
  }, [projectId, logId, attempt]);

  /**
   * "더 보기" 로 늘어난 줄은 화면에만 생긴다 — 알리지 않으면 스크린리더 사용자는 눌렀는데
   * 아무 일도 안 일어난 걸로 안다. 늘어난 뒤 **총 몇 명인지** 를 polite 로 알리고,
   * 포커스는 새로 붙은 첫 줄로 옮긴다(더 없을 땐 버튼이 사라져 포커스가 body 로 떨어진다).
   */
  const [readersLive, setReadersLive] = React.useState("");
  const rowRefs = React.useRef(new Map<number, HTMLDivElement>());
  const pendingRowFocus = React.useRef<number | null>(null);
  React.useEffect(() => {
    const index = pendingRowFocus.current;
    if (index === null) return;
    pendingRowFocus.current = null;
    rowRefs.current.get(index)?.focus();
  }, [readers]);

  async function loadMoreReaders() {
    if (!readersNext || loadingMore) return;
    const my = readersGenRef.current;
    setLoadingMore(true);
    try {
      const q = new URLSearchParams({ before: readersNext.ts, before_id: readersNext.id });
      const d = await adminApi<ReadersPage>(`/api/admin/projects/${projectId}/logs/${logId}/readers?${q}`);
      if (my !== readersGenRef.current) return;
      const shown = (readers?.length ?? 0) + d.readers.length;
      pendingRowFocus.current = readers?.length ?? 0; // 새로 붙은 첫 줄
      setReaders((cur) => [...(cur ?? []), ...d.readers]);
      setReadersNext(d.next);
      setReadersLive(t("readersLoaded", { count: nf.format(shown) }));
    } catch (e) {
      if (my === readersGenRef.current) toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === readersGenRef.current) setLoadingMore(false);
    }
  }

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

  if (failed) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={t("title")} />
        <Card>
          <EmptyState
            icon={ScrollText}
            title={tc("loadFailed")}
            action={
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw aria-hidden="true" className="h-4 w-4" /> {tc("retry")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (!log) {
    return <div className="w-full space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  /** 성공률은 분모가 0일 때 0%가 아니라 "—" 다 — 0/0 을 0% 로 쓰면 실패한 발송처럼 읽힌다 */
  const rate = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 1000) / 10}%` : "—");
  const SENT_BY_KEY: Record<string, "sentByApi" | "sentByAdminToken" | "sentByJourney" | "sentByAbWinner"> = {
    api: "sentByApi",
    "admin-token": "sentByAdminToken",
    journey: "sentByJourney",
    "ab-winner": "sentByAbWinner",
  };
  const sentByText = (v: string | null | undefined) => (!v ? "—" : SENT_BY_KEY[v] ? t(SENT_BY_KEY[v]) : v);

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
            {log.imageUrl && (
              <a href={log.imageUrl} target="_blank" rel="noopener noreferrer" className="block w-fit max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <img src={log.imageUrl} alt={t("imageAlt")} className="max-h-48 max-w-full rounded-lg border border-border bg-surface-muted object-contain" />
                <span className="mt-1 block break-all font-mono text-2xs text-muted-foreground">{log.imageUrl}</span>
              </a>
            )}
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
                <p className="text-xs font-semibold text-muted-foreground">{t("variantsTitle")}</p>
                {log.variants.map((v, i) => (
                  <div key={i} className="rounded-lg border border-border p-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge variant="neutral">{t("variantName", { letter: String.fromCharCode(65 + i) })}</Badge>
                      <span className="truncate font-semibold">{v.title}</span>
                    </span>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{v.body}</p>
                  </div>
                ))}
                <VariantComparison count={log.variants.length} stats={log.variantStats} clicks={variantClicks} />
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
                value={
                  <span className="inline-flex items-center gap-1.5">
                    {log.isTest && <TestChip />}
                    <StatusChip status={log.status} />
                  </span>
                }
              />
              <DataRow label={t("colDelivered")} value={`${nf.format(log.successCount)} / ${nf.format(log.totalCount)} (${rate(log.successCount, log.totalCount)})`} />
              <DataRow label={t("colReadRate")} value={`${nf.format(log.readCount)} (${rate(log.readCount, log.successCount)})`} />
              <DataRow label={t("readers")} value={`${nf.format(log.clickUserCount)} / ${nf.format(log.audienceUserCount)} (${rate(log.clickUserCount, log.audienceUserCount)})`} />
              {log.kakaoFallback && <DataRow label="Kakao" value={nf.format(log.kakaoCount)} />}
              <DataRow label={t("sentBy")} value={sentByText(log.sentBy)} />
              {log.scheduledAt && <DataRow label={t("colSentAt")} value={new Date(log.scheduledAt).toLocaleString(locale)} />}
              <DataRow label={tc("createdAt")} value={new Date(log.createdAt).toLocaleString(locale)} />
              <DataRow label="ID" value={log.id} />
            </dl>
            <DeliveryErrors errors={log.deliveryErrors} />
          </CardContent>
        </Card>
      </div>

      {log.abTest && <AbTestCard projectId={projectId} ab={log.abTest} />}

      {conversions && conversions.count > 0 && <ConversionsCard conversions={conversions} />}

      <Card>
        <CardHeader><CardTitle>{t("readers")}</CardTitle></CardHeader>
        <CardContent>
          {readers === null && <Skeleton className="h-24 w-full" />}
          {readers?.length === 0 && <p className="text-sm text-muted-foreground">{t("noReaders")}</p>}
          {readers && readers.length > 0 && (
            <div className="space-y-1">
              {readers.map((r, i) => (
                <div
                  key={r.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(i, el);
                    else rowRefs.current.delete(i);
                  }}
                  tabIndex={-1}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="font-mono text-xs">{r.externalId ?? t("anonymousReader")}</span>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {r.platform && <Badge variant="neutral">{r.platform}</Badge>}
                    <span>{new Date(r.clickedAt).toLocaleString(locale)}</span>
                  </div>
                </div>
              ))}
              <p role="status" aria-live="polite" className="sr-only">{readersLive}</p>
              {readersNext && (
                <div className="flex justify-center pt-3">
                  <Button variant="outline" size="sm" onClick={loadMoreReaders} disabled={loadingMore}>
                    {loadingMore ? tc("loading") : tc("loadMore")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** FCM 이 돌려주는 사유 중 자주 나오는 것 — 원문 코드는 운영자에게 아무 뜻이 없다 */
const DELIVERY_ERROR_KEY: Record<string, "errUnregistered" | "errInvalidToken" | "errSenderMismatch" | "errQuotaExceeded" | "errUnavailable" | "errInternal"> = {
  UNREGISTERED: "errUnregistered",
  INVALID_ARGUMENT: "errInvalidToken",
  SENDER_ID_MISMATCH: "errSenderMismatch",
  QUOTA_EXCEEDED: "errQuotaExceeded",
  UNAVAILABLE: "errUnavailable",
  INTERNAL: "errInternal",
};

/** 사유가 많아도 화면을 잡아먹지 않게 — 나머지는 "그 외 N건"으로 접는다 */
const DELIVERY_ERRORS_SHOWN = 5;

/**
 * 실패 사유 요약 — 사유별 건수를 많은 순으로. JSON 덩어리로 쏟지 않는다:
 * 상세 화면에서 정작 알고 싶은 건 "무엇이 몇 건 실패했나" 한 줄이다.
 * 아는 사유는 번역하고, 모르는 사유는 원문 코드를 그대로 둔다(신고할 때 그 값이 필요하다).
 */
function DeliveryErrors({ errors }: { errors?: Record<string, number> | null }) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const rows = React.useMemo(
    () => Object.entries(errors ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
    [errors]
  );
  if (rows.length === 0) return null;

  const shown = rows.slice(0, DELIVERY_ERRORS_SHOWN);
  const restCount = rows.slice(DELIVERY_ERRORS_SHOWN).reduce((n, [, v]) => n + v, 0);
  const total = rows.reduce((n, [, v]) => n + v, 0);

  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      <p className="text-xs font-semibold text-muted-foreground">
        {t("deliveryErrorsTitle", { count: nf.format(total) })}
      </p>
      <ul className="space-y-1">
        {shown.map(([reason, count]) => {
          const key = DELIVERY_ERROR_KEY[reason];
          return (
            <li key={reason} className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
              {/* 번역된 이름 옆에 원문 코드 — 신고·검색은 코드로 한다 */}
              <span className="min-w-0 truncate">
                {key ? t(key) : <span className="font-mono">{reason}</span>}
                {key && <span className="ms-1.5 font-mono text-2xs text-muted-foreground">{reason}</span>}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{nf.format(count)}</span>
            </li>
          );
        })}
        {restCount > 0 && (
          <li className="text-xs text-muted-foreground">{t("deliveryErrorsMore", { count: nf.format(restCount) })}</li>
        )}
      </ul>
    </div>
  );
}

type VariantStat = { sent: number; success: number };

function variantStat(stats: Record<string, VariantStat> | null, i: number): VariantStat | undefined {
  return stats?.[String(i)] ?? stats?.[`v${i}`];
}

/** 비율이 가장 높은 하나. 잴 수 있는 변형이 둘 미만이거나 1등이 동률이면 "제일 낫다"고 말하지 않는다 */
function bestRateIndex(rates: Array<number | null>): number | null {
  const measured = rates.filter((r): r is number => r !== null);
  if (measured.length < 2) return null;
  const top = Math.max(...measured);
  const winners = rates.flatMap((r, i) => (r === top ? [i] : []));
  return winners.length === 1 ? winners[0] : null;
}

/**
 * 변형별 발송·성공·성공률·클릭·클릭률을 한 표로 나란히 놓는다 —
 * 문장으로 흩어 두면 어느 쪽이 나은지 비교가 안 된다.
 * 클릭률의 분모는 그 변형의 **성공 건수**다. 전체 성공으로 나누면 변형이 늘수록 모든 변형이 낮아 보인다.
 */
function VariantComparison({
  count,
  stats,
  clicks,
}: {
  count: number;
  stats: Record<string, VariantStat> | null;
  clicks: VariantClicks | null;
}) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const rows = Array.from({ length: count }, (_, i) => variantStat(stats, i));
  const clickByVariant = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const r of clicks?.byVariant ?? []) if (r.variant !== null) m.set(r.variant, r.clicks);
    return m;
  }, [clicks]);
  const best = bestRateIndex(rows.map((s) => (s && s.sent > 0 ? s.success / s.sent : null)));
  const bestClick = bestRateIndex(
    rows.map((s, i) => (s && s.success > 0 && clickByVariant.has(i) ? (clickByVariant.get(i) ?? 0) / s.success : null))
  );
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t("variantCompareCaption")}</caption>
        <thead className="border-b border-border bg-surface-muted/50">
          <tr className="text-xs font-semibold text-muted-foreground">
            <th scope="col" className="px-3.5 py-2 text-start">{t("variantColName")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColSent")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColSuccess")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColRate")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColClicks")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColClickRate")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s, i) => {
            const clicked = clickByVariant.get(i);
            const measurable = Boolean(s && s.success > 0 && clicks);
            return (
              <tr key={i}>
                <th scope="row" className="px-3.5 py-2 text-start font-semibold">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {t("variantName", { letter: String.fromCharCode(65 + i) })}
                    {best === i && <Badge variant="success">{t("variantBest")}</Badge>}
                    {bestClick === i && <Badge variant="primary">{t("variantBestClick")}</Badge>}
                  </span>
                </th>
                <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{s ? nf.format(s.sent) : "—"}</td>
                <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{s ? nf.format(s.success) : "—"}</td>
                <td className="px-3.5 py-2 text-end">
                  {s ? <RateBar num={s.success} den={s.sent} tone="success" /> : <span className="text-xs text-muted-foreground">{t("variantNoStat")}</span>}
                </td>
                <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{clicks ? nf.format(clicked ?? 0) : "—"}</td>
                <td className="px-3.5 py-2 text-end">
                  {measurable && s ? (
                    <RateBar num={clicked ?? 0} den={s.success} tone="primary" />
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("variantNoStat")}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const variantLetter = (i: number) => String.fromCharCode(65 + i);

/**
 * A/B 자동 승자 — 표본 결과·승자(또는 승자가 없는 이유)·승자 본발송.
 *
 * 승자가 없을 때 **이유를 말하는 것**이 이 카드의 핵심이다. 조용히 A 를 고르면 운영자는
 * A/B 를 했다고 믿지만 실제로는 아무것도 재지 않은 것이 된다.
 */
function AbTestCard({ projectId, ab }: { projectId: string; ab: AbTest }) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const at = (iso: string) => new Date(iso).toLocaleString(locale);

  if (ab.role === "winner") {
    return (
      <Card>
        <CardHeader><CardTitle>{t("abTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{t("abWinnerSend", { letter: variantLetter(ab.variant), percent: 100 - ab.samplePercent })}</p>
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}/logs/${ab.parentLogId}`}>{t("abParentLink")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const decision = ab.decision;
  return (
    <Card>
      <CardHeader><CardTitle>{t("abTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("abConfig", { percent: ab.samplePercent, minutes: ab.waitMinutes })}
        </p>
        {!decision && (
          <p className="text-sm">{ab.decideAt ? t("abPending", { at: at(ab.decideAt) }) : t("abPendingSample")}</p>
        )}
        {decision && (
          <>
            <p className="text-sm font-semibold">
              {decision.winner !== null
                ? t("abDecided", { letter: variantLetter(decision.winner) })
                : t(
                    decision.reason === "tie" ? "abNoWinnerTie"
                      : decision.reason === "no_clicks" ? "abNoWinnerNoClicks"
                      : "abNoWinnerSample",
                    { min: AB_MIN_VARIANT_SAMPLE, margin: Math.round(AB_TIE_MARGIN * 100) }
                  )}
            </p>
            <AbResultsTable results={decision.results} winner={decision.winner} />
            <p className="text-xs text-muted-foreground">{t("abDecidedAt", { at: at(decision.at) })}</p>
            {decision.followUpLogId && (
              <Button asChild variant="outline">
                <Link href={`/projects/${projectId}/logs/${decision.followUpLogId}`}>{t("abFollowUpLink")}</Link>
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 판정에 쓴 표본 결과 — 나중에 다시 계산하지 않고 그때 굳힌 값을 그대로 보여 준다 */
function AbResultsTable({ results, winner }: { results: AbVariantResult[]; winner: number | null }) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t("abResultsCaption")}</caption>
        <thead className="border-b border-border bg-surface-muted/50">
          <tr className="text-xs font-semibold text-muted-foreground">
            <th scope="col" className="px-3.5 py-2 text-start">{t("variantColName")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColSuccess")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColClicks")}</th>
            <th scope="col" className="px-3.5 py-2 text-end">{t("variantColClickRate")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {results.map((r) => (
            <tr key={r.variant}>
              <th scope="row" className="px-3.5 py-2 text-start font-semibold">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {t("variantName", { letter: variantLetter(r.variant) })}
                  {winner === r.variant && <Badge variant="success">{t("abWinnerBadge")}</Badge>}
                </span>
              </th>
              <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{nf.format(r.success)}</td>
              <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{nf.format(r.clicks)}</td>
              <td className="px-3.5 py-2 text-end">
                {r.rate === null ? (
                  <span className="text-xs text-muted-foreground">{t("variantNoStat")}</span>
                ) : (
                  <RateBar num={r.clicks} den={r.success} tone="primary" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 전환 요약 — 건수·금액과 이름별 상위. 금액은 최소 화폐 단위라 단위를 글로 밝힌다. */
function ConversionsCard({ conversions }: { conversions: Conversions }) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  return (
    <Card>
      <CardHeader><CardTitle>{t("conversionsTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">{t("conversionsCount")}</dt>
            <dd className="mt-1 text-xl font-extrabold tabular-nums">{nf.format(conversions.count)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">{t("conversionsValue")}</dt>
            <dd className="mt-1 text-xl font-extrabold tabular-nums">{nf.format(conversions.valueCents)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{t("conversionsHint")}</p>
        {conversions.byName.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {conversions.byName.map((r) => (
              <li key={r.name} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate font-mono text-xs">{r.name}</span>
                <span className="shrink-0 text-end tabular-nums text-muted-foreground">
                  {t("conversionsRow", { count: nf.format(r.count), value: nf.format(r.valueCents) })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("conversionsNone")}</p>
        )}
      </CardContent>
    </Card>
  );
}
