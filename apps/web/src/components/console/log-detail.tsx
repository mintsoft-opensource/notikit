"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Ban, RefreshCw, SearchX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { EmptyState } from "@/components/ui/empty-state";
import { DeltaLine } from "@/components/ui/stat-tile";
import { FIELD_HINT_TEXT } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { useNumberFormat } from "@/lib/number-format";
import { cn } from "@/lib/utils";
import { AdminApiError, adminApi, useAdminErrorText } from "@/lib/admin-client";
import { RateBar, StatusChip, TestChip } from "./log-status";
import { CancelSendDialog, isCancelable, useCancelSend, type CanceledLog } from "./send-cancel";
import { AB_MIN_VARIANT_SAMPLE, AB_TIE_MARGIN, type AbTest, type AbVariantResult } from "@/lib/ab-test";
import { FOCUS_RING, FOCUS_RING_INSET } from "@/components/ui/focus-ring";

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
  /** 단말이 받았다고 보고한 수. FCM 접수(successCount)와 **다른 축**이다 — 접수는 기기가 꺼져 있어도 성공한다 */
  deliveredCount: number;
  scheduledAt: string | null;
  canceledAt: string | null;
  canceledBy: string | null;
  /** 받는 사람 현지 시각 "HH:MM" — 있으면 기기 시간대로 묶어 회차를 나눠 보냈다 */
  localTime?: string | null;
  /** 로케일별 문구 — `{ default: {...}, ko: {...} }` */
  localeVariants?: LocaleContent | null;
  /** 기본 문구로 떨어진 사람 수. 숨기면 "번역을 넣었다" 는 믿음만 남는다 */
  localeFallbacks?: LocaleFallback | null;
  /** 캠페인별 재정의 — 프로젝트 설정 중 이 발송이 덮은 것 */
  ignoreQuietHours?: boolean | null;
  maxSendsPerMinute?: number | null;
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

type LocaleText = { title: string; body: string };
type LocaleContent = Record<string, LocaleText>;
/** 기본 문구로 떨어진 사람 수 — 전체와 로케일별. 로케일을 모르는 기기는 `""` 로 센다. */
type LocaleFallback = { total: number; byLocale: Record<string, number> };

/**
 * 대조군 — 보내지 않고 전환만 비교한 집단.
 * `lift` 는 대조군 전환율이 0 이면 비율이 성립하지 않아 null 이다(0% 나 무한대로 적지 않는다).
 */
type Holdout = {
  percent: number | null;
  devices: number;
  conversions: { count: number; valueCents: number };
  /** 발송군의 전환/분모 — 대조군과 **같은 종류의 비율**로 놓기 위해 서버가 함께 준다 */
  sent: { converted: number; total: number };
  lift: number | null;
};

/** 변형별 클릭 — variant 가 null 인 행은 변형 없이 나간 발송의 클릭이다 */
type VariantClicks = { byVariant: Array<{ variant: number | null; clicks: number }> };

type Conversions = {
  count: number;
  /** 최소 화폐 단위 합계(원·센트). 화면이 단위를 밝힌다 */
  valueCents: number;
  byName: Array<{ name: string; count: number; valueCents: number }>;
};

/** 이 발송이 넣은 인박스와 그중 읽힌 수 — 사람 단위 */
type Inbox = { total: number; read: number };

type LogDetailResponse = { log: Log; clicks?: VariantClicks; conversions?: Conversions; holdout?: Holdout; inbox?: Inbox };

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
  const nf = useNumberFormat();

  const errorText = useAdminErrorText();

  const [log, setLog] = React.useState<Log | null>(null);
  const [variantClicks, setVariantClicks] = React.useState<VariantClicks | null>(null);
  const [conversions, setConversions] = React.useState<Conversions | null>(null);
  const [holdout, setHoldout] = React.useState<Holdout | null>(null);
  const [inbox, setInbox] = React.useState<Inbox | null>(null);
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
    setHoldout(null);
    setInbox(null);
    setMissing(false);
    setFailed(false);
    (async () => {
      try {
        const d = await adminApi<LogDetailResponse>(`/api/admin/projects/${projectId}/logs/${logId}`);
        if (stale) return;
        setLog(d.log);
        setVariantClicks(d.clicks ?? null);
        setConversions(d.conversions ?? null);
        setHoldout(d.holdout ?? null);
        setInbox(d.inbox ?? null);
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

  /**
   * 취소한 뒤 **다시 받아오지 않고** 응답을 그대로 반영한다 — 응답의 `sent` 가 취소 시점에
   * 굳힌 수이고, 재조회는 그사이 워커가 마지막 페이지를 적으면 다른 수를 보여 줄 수 있다.
   */
  const onCanceled = React.useCallback((c: CanceledLog) => {
    setLog((cur) =>
      cur
        ? {
            ...cur,
            status: c.status,
            canceledAt: c.canceled_at,
            canceledBy: c.canceled_by,
            totalCount: c.sent.total,
            successCount: c.sent.success,
            failureCount: c.sent.failure,
          }
        : cur
    );
  }, []);
  const cancel = useCancelSend(projectId, onCanceled);

  // 목록과 같은 묶음으로 돌아간다 — 사람을 지정한 발송(single·multi)만 "단건", 나머지는 "토픽·전체"
  const backHref = `/projects/${projectId}/logs/${log?.type === "single" || log?.type === "multi" ? "single" : "topic"}`;

  // "없음"과 "못 가져옴"은 같은 껍데기(Card + EmptyState)로 낸다 — 한쪽만 맨 버튼이면
  // 같은 자리에서 다른 화면처럼 보이고, 되돌아갈 버튼이 매번 다른 곳에 선다.
  if (missing) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={tc("notFound")} />
        <Card>
          <EmptyState
            icon={SearchX}
            title={tc("notFound")}
            description={tc("notFoundDesc")}
            action={
              <Button asChild variant="outline">
                <Link href={`/projects/${projectId}/logs`}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={t("title")} />
        <Card>
          <EmptyState
            icon={AlertTriangle}
            // 빈 목록과 같은 회색이면 "로그가 없다"로 읽힌다 — 여기는 못 가져온 것이다
            tone="error"
            title={tc("loadFailed")}
            description={tc("loadFailedDesc")}
            action={
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw aria-hidden="true" className="size-4" /> {tc("retry")}
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
          <>
            {isCancelable(log.status) && (
              <Button variant="destructive" onClick={() =>
                  cancel.ask({
                    id: log.id,
                    title: log.title,
                    sent: { success: log.successCount, failure: log.failureCount, total: log.totalCount },
                  })
                }>
                <Ban aria-hidden="true" className="size-4" /> {t("cancel")}
              </Button>
            )}
            <Button asChild variant="ghost">
              <Link href={backHref}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("colTitle")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="whitespace-pre-wrap break-words text-sm">{log.body}</p>
            {log.imageUrl && (
              <a href={log.imageUrl} target="_blank" rel="noopener noreferrer" className={cn("block w-fit max-w-full rounded-tile", FOCUS_RING)}>
                <img src={log.imageUrl} alt={t("imageAlt")} className="max-h-48 max-w-full rounded-tile border border-border bg-surface-muted object-contain" />
                <span className="mt-1 block break-all font-mono text-2xs text-muted-foreground">{log.imageUrl}</span>
              </a>
            )}
            {log.deepLink && (
              <p className="break-all font-mono text-xs text-muted-foreground">{log.deepLink}</p>
            )}
            {log.data && Object.keys(log.data).length > 0 && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-tile bg-surface-muted p-3.5 text-2xs text-muted-foreground">
                {JSON.stringify(log.data, null, 2)}
              </pre>
            )}
            {log.variants && log.variants.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs font-semibold text-muted-foreground">{t("variantsTitle")}</p>
                {log.variants.map((v, i) => (
                  <div key={i} className="rounded-tile border border-border p-3.5 text-sm">
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
              {/* 접수(success)와 **다른 줄**이다 — 접수는 기기가 꺼져 있어도 성공한다 */}
              <DataRow
                label={
                  <span className="flex flex-col">
                    <span>{t("colReceipts")}</span>
                    <span className="text-2xs text-muted-foreground">{t("receiptsHint")}</span>
                  </span>
                }
                /**
                 * 보고가 **한 건도 없으면** 0 이 아니라 "—" 다. 0 은 "아무에게도 안 닿았다"로
                 * 읽히는데, 실제로 흔한 원인은 앱이 수신 보고를 안 붙인 것이다 — 멀쩡히 배달된
                 * 발송을 실패로 오해하게 만드는 쪽이 아무것도 안 보여 주는 것보다 나쁘다.
                 */
                value={
                  (log.deliveredCount ?? 0) === 0
                    ? <span title={t("receiptsNone")}>—</span>
                    : `${nf.format(log.deliveredCount)} (${rate(log.deliveredCount, log.successCount)})`
                }
              />
              {/* 인박스를 넣은 발송(single·multi)만 보여 준다 — 없는 발송에 0% 를 적으면 "아무도 안 읽었다"로 읽힌다 */}
              {inbox && inbox.total > 0 && (
                <DataRow label={t("colInboxRead")} value={`${nf.format(inbox.read)} / ${nf.format(inbox.total)} (${rate(inbox.read, inbox.total)})`} />
              )}
              <DataRow label={t("readers")} value={`${nf.format(log.clickUserCount)} / ${nf.format(log.audienceUserCount)} (${rate(log.clickUserCount, log.audienceUserCount)})`} />
              {log.kakaoFallback && <DataRow label="Kakao" value={nf.format(log.kakaoCount)} />}
              <DataRow label={t("sentBy")} value={sentByText(log.sentBy)} />
              {log.canceledAt && <DataRow label={t("canceledAt")} value={new Date(log.canceledAt).toLocaleString(locale)} />}
              {log.canceledBy && <DataRow label={t("canceledBy")} value={log.canceledBy} />}
              {/* 캠페인별 재정의는 **덮었을 때만** 적는다 — 기본값까지 줄로 두면 무엇이 특별한지 안 보인다 */}
              {log.ignoreQuietHours && <DataRow label={t("ignoreQuietHours")} value={t("ignoreQuietHoursValue")} />}
              {log.maxSendsPerMinute !== null && log.maxSendsPerMinute !== undefined && (
                <DataRow
                  label={t("maxSendsPerMinute")}
                  value={log.maxSendsPerMinute === 0 ? t("unlimited") : nf.format(log.maxSendsPerMinute)}
                />
              )}
              {log.localTime && <DataRow label={t("localTime")} value={log.localTime} />}
              {log.scheduledAt && <DataRow label={t("colSentAt")} value={new Date(log.scheduledAt).toLocaleString(locale)} />}
              <DataRow label={tc("createdAt")} value={new Date(log.createdAt).toLocaleString(locale)} />
              <DataRow label="ID" value={log.id} />
            </dl>
            <DeliveryErrors errors={log.deliveryErrors} />
          </CardContent>
        </Card>
      </div>

      {/* 취소는 "멈췄다" 가 아니라 "여기까지 갔다" 가 핵심이다 — 나간 수를 화면에 남긴다 */}
      {log.status === "canceled" && (
        <Card>
          <CardHeader><CardTitle>{t("canceledTitle")}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              {t("canceledSent", {
                success: nf.format(log.successCount),
                total: nf.format(log.totalCount),
                failure: nf.format(log.failureCount),
                holdout: nf.format(holdout?.devices ?? 0),
              })}
            </p>
            <p className={FIELD_HINT_TEXT}>{t("canceledHint")}</p>
          </CardContent>
        </Card>
      )}

      {log.localeVariants && Object.keys(log.localeVariants).length > 0 && (
        <LocaleCard content={log.localeVariants} fallback={log.localeFallbacks ?? null} />
      )}

      {holdout && holdout.percent !== null && holdout.percent > 0 && <HoldoutCard holdout={holdout} />}

      {conversions && conversions.count > 0 && <ConversionsCard conversions={conversions} />}

      {/* 전환(무엇이 일어났는가) 다음에 A/B(어느 변형이 그렇게 만들었는가) — 원인은 결과 뒤에 읽힌다 */}
      {log.abTest && <AbTestCard projectId={projectId} ab={log.abTest} />}

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
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm last:border-b-0",
                    FOCUS_RING_INSET
                  )}
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

      <CancelSendDialog target={cancel.target} busy={cancel.busy} onConfirm={cancel.confirm} onClose={cancel.close} />
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
  const nf = useNumberFormat();
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
          <li className={FIELD_HINT_TEXT}>{t("deliveryErrorsMore", { count: nf.format(restCount) })}</li>
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
  const nf = useNumberFormat();
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
    <div className="overflow-x-auto rounded-tile border border-border">
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
                  {s ? <RateBar num={s.success} den={s.sent} tone="success" /> : <span className={FIELD_HINT_TEXT}>{t("variantNoStat")}</span>}
                </td>
                <td className="px-3.5 py-2 text-end tabular-nums text-muted-foreground">{clicks ? nf.format(clicked ?? 0) : "—"}</td>
                <td className="px-3.5 py-2 text-end">
                  {measurable && s ? (
                    <RateBar num={clicked ?? 0} den={s.success} tone="primary" />
                  ) : (
                    <span className={FIELD_HINT_TEXT}>{t("variantNoStat")}</span>
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
        <CardContent className="space-y-4">
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
        <p className={FIELD_HINT_TEXT}>
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
            <p className={FIELD_HINT_TEXT}>{t("abDecidedAt", { at: at(decision.at) })}</p>
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
  const nf = useNumberFormat();
  return (
    <div className="overflow-x-auto rounded-tile border border-border">
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
                  <span className={FIELD_HINT_TEXT}>{t("variantNoStat")}</span>
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
  const nf = useNumberFormat();
  return (
    <Card>
      <CardHeader><CardTitle>{t("conversionsTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
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
        <p className={FIELD_HINT_TEXT}>{t("conversionsHint")}</p>
        {conversions.byName.length > 0 ? (
          <ul className="divide-y divide-border rounded-tile border border-border">
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

/**
 * 로케일별 문구와 **폴백 관측**.
 *
 * 폴백 수를 숨기면 "일본어를 넣었다" 는 믿음만 남고, 실제로는 `ja_JP` 가 `ja` 에 안 붙어
 * 아무도 못 받은 상태를 아무도 모른다. 그래서 몇 명이 기본 문구를 받았는지, 그 사람들의
 * 로케일이 무엇이었는지를 문구 목록보다 **먼저** 보여 준다.
 */
function LocaleCard({ content, fallback }: { content: LocaleContent; fallback: LocaleFallback | null }) {
  const t = useTranslations("logs");
  const locale = useLocale();
  const nf = useNumberFormat();
  const rows = React.useMemo(
    () => Object.entries(fallback?.byLocale ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
    [fallback]
  );
  const total = fallback?.total ?? 0;

  return (
    <Card>
      <CardHeader><CardTitle>{t("localesTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-tile border border-border p-3.5">
          <p className="text-sm font-semibold">
            {total > 0 ? t("localeFallbackTotal", { count: nf.format(total) }) : t("localeFallbackNone")}
          </p>
          <p className={FIELD_HINT_TEXT}>{t("localeFallbackHint")}</p>
          {rows.length > 0 && (
            <ul className="space-y-1 border-t border-border pt-2">
              {rows.map(([tag, count]) => (
                <li key={tag} className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
                  {/* 로케일을 모르는 기기는 빈 문자열로 온다 — 빈 줄로 두면 무엇인지 알 수 없다 */}
                  <span className="min-w-0 truncate font-mono">{tag || t("localeUnknown")}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{nf.format(count)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ul className="space-y-2">
          {Object.entries(content).map(([tag, text]) => (
            <li key={tag} className="rounded-tile border border-border p-3.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant="neutral">{tag === "default" ? t("localeDefault") : tag}</Badge>
                <span className="truncate font-semibold">{text.title}</span>
              </span>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{text.body}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * 대조군 — 보내지 않고 전환만 비교한 집단. A/B 는 변형끼리만 비교하므로
 * "푸시가 없었을 때보다 나은가" 는 여기서만 답이 나온다.
 *
 * 리프트가 null 인 경우를 0% 로 적지 않는다 — 대조군 전환이 하나도 없으면 비율 자체가
 * 성립하지 않는다. "0% 개선" 과 "잴 수 없음" 은 정반대의 뜻이다.
 */
function HoldoutCard({ holdout }: { holdout: Holdout }) {
  const t = useTranslations("logs");
  const nf = useNumberFormat();
  const rf = useNumberFormat({ style: "percent", maximumFractionDigits: 2 });

  /** 분모가 0이면 비율이 아니라 "잴 수 없음" 이다 — 0% 로 적으면 실패한 것처럼 읽힌다 */
  const rate = (converted: number, total: number) => (total > 0 ? rf.format(converted / total) : "—");
  const control = { converted: holdout.conversions.count, total: holdout.devices };
  const treatment = holdout.sent;

  return (
    <Card>
      <CardHeader><CardTitle>{t("holdoutTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {/*
          대조군과 발송군을 **같은 카드에서 비율로** 나란히 둔다. 원시 건수 네 개는 분모가
          서로 달라(대조군 devices vs 발송 성공 건수) 눈으로 비교되지 않는다 — 비교하라고
          놓은 숫자가 비교 불가능하면 없는 것만 못하다.
        */}
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[
            { key: "holdoutControl", side: control, hint: t("holdoutControlHint", { percent: holdout.percent ?? 0 }) },
            { key: "holdoutTreatment", side: treatment, hint: t("holdoutTreatmentHint") },
          ].map(({ key, side, hint }) => (
            <div key={key} className="rounded-tile border border-border p-3.5">
              <dt className="text-xs font-semibold text-muted-foreground">{t(key as "holdoutControl")}</dt>
              <dd className="mt-1 text-xl font-extrabold tabular-nums">{rate(side.converted, side.total)}</dd>
              <p className={FIELD_HINT_TEXT}>
                {t("holdoutRatio", { converted: nf.format(side.converted), total: nf.format(side.total) })}
              </p>
              <p className="mt-1 text-2xs text-muted-foreground">{hint}</p>
            </div>
          ))}
        </dl>

        <div className="rounded-tile border border-border p-3.5">
          <p className="text-xs font-semibold text-muted-foreground">{t("holdoutLift")}</p>
          {holdout.lift === null ? (
            <p className="mt-1 text-xl font-extrabold tabular-nums text-muted-foreground">—</p>
          ) : (
            // 부호는 색·글리프·문장으로 — 중립 볼드 숫자는 +40% 와 −40% 가 같아 보인다
            <DeltaLine delta={{ value: holdout.lift * 100, unit: "%", goodWhen: "up", label: t("holdoutLiftLabel") }} />
          )}
          <p className={cn(FIELD_HINT_TEXT, "mt-1")}>
            {holdout.lift === null ? t("holdoutLiftNone") : t("holdoutHint")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
