"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Play, ScrollText, ChevronDown, ChevronRight, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { Label } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";
import { localDayBoundaryIso } from "@/lib/local-day";
import { RateBar, StatusChip, TestChip } from "./log-status";

type Log = {
  id: string;
  title: string;
  type: string;
  target: string | null;
  status: string;
  totalCount: number;
  successCount: number;
  audienceUserCount: number;
  audienceDeviceCount: number;
  clickCount: number;
  clickUserCount: number;
  createdAt: string;
  isTest?: boolean;
  imageUrl?: string | null;
};

/** 발송 타입 필터 — 없으면 전체 */
export type LogFilter = "single" | "topic" | undefined;

/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;
type LogsResponse = { logs: Log[]; next: Cursor };

// 읽은 사람 상세는 차트까지 싣고 있어 무겁다 — 행을 펼칠 때만 불러온다
const ReaderDetail = dynamic(() => import("./log-readers").then((m) => m.ReaderDetail), {
  ssr: false,
  loading: () => (
    <div className="space-y-2 border-t border-border px-3.5 py-2.5">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  ),
});

export function LogsConsole({ projectId, filter }: { projectId?: string; filter?: LogFilter }) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [logs, setLogs] = React.useState<Log[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // 요청 세대 — 초기 로드가 올리고 "더 보기"는 같은 세대인지만 본다
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);
  // 입력 중인 값과 실제 조회에 쓰는 값을 나눈다 — 타이핑마다 조회하면 부분 입력된
  // 날짜("2026-0")로 계속 요청이 나간다.
  const [fromInput, setFromInput] = React.useState("");
  const [toInput, setToInput] = React.useState("");
  const [range, setRange] = React.useState<{ from: string; to: string }>({ from: "", to: "" });

  /** 조회 조건 쿼리 — 초기 로드와 "더 보기"가 같은 조건을 쓴다 */
  const buildQuery = React.useCallback(
    (cursor?: Cursor) => {
      const qs = new URLSearchParams();
      if (filter) qs.set("type", filter);
      // 날짜마다 그날의 로컬 자정을 따로 환산한다 — 오늘 오프셋을 재사용하면 서머타임 경계에서 한 시간 어긋난다
      const from = range.from ? localDayBoundaryIso(range.from) : null;
      const to = range.to ? localDayBoundaryIso(range.to, true) : null;
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (cursor) {
        qs.set("before", cursor.ts);
        qs.set("before_id", cursor.id);
      }
      return qs.size > 0 ? `?${qs}` : "";
    },
    [filter, range]
  );

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return;
      const my = ++reqRef.current;
      setLoading(true);
      setLogs([]);
      setNext(null);
      setLoadingMore(false);
      setOpen(null);
      try {
        const d = await adminApi<LogsResponse>(`/api/admin/projects/${id}/logs${buildQuery()}`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setLogs(d.logs);
        setNext(d.next);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(errorText(e, t("loadFailed")));
      } finally {
        if (my === reqRef.current) setLoading(false);
      }
    },
    [t, buildQuery, errorText]
  );

  async function loadMore() {
    if (!sel || !next || loadingMore) return;
    // 세대를 올리지 않고 붙잡아 둔다 — 그사이 필터·프로젝트가 바뀌면 옛 조건의 다음 페이지를 새 목록에 붙이지 않는다
    const my = reqRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<LogsResponse>(`/api/admin/projects/${sel}/logs${buildQuery(next)}`);
      if (my !== reqRef.current) return;
      setLogs((cur) => [...cur, ...d.logs]);
      setNext(d.next);
    } catch (e) {
      if (my !== reqRef.current) return;
      toast.error(errorText(e, t("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoadingMore(false);
    }
  }

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
    else setLogs([]);
  }, [sel, load]);

  async function processQueue() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number; failed: number }>(`/api/admin/projects/${sel}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processResult", { processed: d.processed, failed: d.failed }));
      load(sel);
    } catch (e) {
      toast.error(errorText(e, t("processFailed")));
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const title = filter === "single" ? t("titleSingle") : filter === "topic" ? t("titleTopic") : t("title");
  const subtitle = filter === "single" ? t("subtitleSingle") : filter === "topic" ? t("subtitleTopic") : t("subtitle");
  // 읽은 사람 목록은 여러 명이 대상인 발송에서만 의미가 있다
  const expandable = filter !== "single";

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={title}
        description={subtitle}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sel && load(sel)} disabled={!sel}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> {tc("refresh")}
            </Button>
            <Button size="sm" onClick={processQueue} disabled={!sel}>
              <Play aria-hidden="true" className="h-4 w-4" /> {t("processQueue")}
            </Button>
          </>
        }
      />

      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="log-from">{t("rangeFrom")}</Label>
          <DatePicker id="log-from" value={fromInput} max={toInput || undefined} onChange={setFromInput} placeholder={t("rangeFrom")} clearLabel={t("rangeClear")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-to">{t("rangeTo")}</Label>
          <DatePicker id="log-to" value={toInput} min={fromInput || undefined} onChange={setToInput} placeholder={t("rangeTo")} clearLabel={t("rangeClear")} />
        </div>
        <Button
          disabled={!sel}
          onClick={() => {
            // 뒤집힌 범위는 조용히 0건이 나와 "데이터가 없다"로 오독된다
            if (fromInput && toInput && fromInput > toInput) return toast.error(t("rangeInvalid"));
            setRange({ from: fromInput, to: toInput });
          }}
        >
          <Search aria-hidden="true" /> {t("rangeApply")}
        </Button>
        {(range.from || range.to) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFromInput("");
              setToInput("");
              setRange({ from: "", to: "" });
            }}
          >
            {t("rangeClear")}
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!sel && <EmptyState icon={ScrollText} title={tc("selectProjectFirst")} />}
          {sel && loading && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {sel && !loading && logs.length === 0 && <EmptyState icon={ScrollText} title={t("empty")} />}
          {logs.length > 0 && (
            <>
            <DataTable label={title} rowCount={logs.length + 1}>
            <TableHeader
              grid="xl:grid-cols-[auto_minmax(0,1fr)_9rem_11rem_10rem_7rem_7.5rem]"
              columns={[
                { label: "", blank: true },
                { label: t("colTitle") },
                { label: t("colTargetName") },
                { label: t("colSentAt"), align: "end" },
                { label: t("colDelivered"), align: "end" },
                { label: t("colReadRate"), align: "end" },
                { label: t("colStatus"), align: "end" },
              ]}
            />
            <TableBody>
              {logs.map((l) => {
                const isOpen = open === l.id;
                return (
                  // 펼침 상세를 담으려면 한 겹이 더 필요하다. presentation 을 주지 않으면
                  // 이 요소가 rowgroup 과 row 사이에 끼어 표 구조가 끊긴다.
                  <div key={l.id} role="presentation">
                    <TableRow className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[auto_minmax(0,1fr)_9rem_11rem_10rem_7rem_7.5rem]">
                      <TableCell label={t("readers")}>
                      {expandable ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setOpen(isOpen ? null : l.id)}
                          aria-expanded={isOpen}
                          aria-label={`${t("readers")} — ${l.title}`}
                          className="col-start-1 row-start-1 text-muted-foreground hover:text-foreground"
                        >
                          {isOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                        </Button>
                      ) : (
                        <span className="hidden xl:block" />
                      )}
                      </TableCell>
                      <TableCell label={t("colTitle")} className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                        <Link
                          href={`/projects/${sel}/logs/${l.id}`}
                          className="truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {l.title}
                        </Link>
                        {l.isTest && <TestChip />}
                      </TableCell>
                      <TableCell label={t("colTargetName")} className="truncate text-xs text-muted-foreground">
                        {l.target ? <span className="font-mono">{l.target}</span> : l.type}
                      </TableCell>
                      <TableCell label={t("colSentAt")} className="text-xs tabular-nums text-muted-foreground xl:text-end">
                        {df.format(new Date(l.createdAt))}
                      </TableCell>
                      <TableCell label={t("colDelivered")} className="flex items-center justify-end gap-2 text-xs font-semibold tabular-nums">
                        <span className="text-muted-foreground">{nf.format(l.successCount)}/{nf.format(l.totalCount)}</span>
                        <RateBar num={l.successCount} den={l.totalCount} tone="success" />
                      </TableCell>
                      <TableCell label={t("colReadRate")} className="flex items-center justify-end text-xs font-semibold">
                        <RateBar num={l.clickUserCount} den={l.audienceUserCount} tone="primary" />
                      </TableCell>
                      <TableCell label={t("colStatus")} className="justify-self-end"><StatusChip status={l.status} /></TableCell>
                    </TableRow>
                    {expandable && isOpen && <ReaderDetail projectId={sel} logId={l.id} />}
                  </div>
                );
              })}
            </TableBody>
            {next && (
              <div className="flex justify-center border-t border-border p-3">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? tc("loading") : tc("loadMore")}
                </Button>
              </div>
            )}
            </DataTable>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
