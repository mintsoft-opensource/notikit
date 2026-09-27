"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Download, RefreshCw, ScrollText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Field, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DatePicker } from "@/components/ui/date-picker";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { localDayBoundaryIso } from "@/lib/local-day";
import { AUDIT_ACTIONS, baseAction, isDenied, type AuditEntryDto, type DiffEntry } from "@/lib/audit-shared";
import { CSV_ROW_LIMIT } from "@/lib/csv-export";

type Cursor = { ts: string; id: string } | null;
type ListResponse = { entries: AuditEntryDto[]; next: Cursor };
type Actor = { value: string; label: string };

const GRID = "grid grid-cols-1 gap-x-4 gap-y-1 px-3.5 py-2.5 xl:grid-cols-[13rem_12rem_14rem_1fr]";
const LOG_TYPES = ["", "single", "topic", "broadcast"] as const;
const ENGAGEMENT_RANGES = ["7d", "30d", "90d"] as const;

/**
 * action → 메시지 키. next-intl 은 키의 `.` 을 **중첩 경로**로 읽으므로
 * `action.project.settings.update` 를 찾다가 MISSING_MESSAGE 로 떨어진다 —
 * 화면에는 행위 이름 대신 키 문자열이 그대로 나온다. 점을 밑줄로 바꿔 한 단계로 둔다.
 */
const actionKey = (action: string) => `action.${action.replaceAll(".", "_")}`;

/** 값 하나를 한 줄로. 값이 길면 표가 아니라 벽이 된다. */
function short(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * 감사 로그 — 읽기 전용. 누가·언제·무엇을·무엇에서 무엇으로 바꿨는지.
 *
 * 화면에 건 필터가 곧 내보내기 범위다(같은 쿼리 문자열을 export 엔드포인트에 그대로 넘긴다).
 * 화면은 9월만 보는데 파일에는 전체가 담기는 상황을 만들지 않는다.
 */
export function AuditConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audit");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();

  const [entries, setEntries] = React.useState<AuditEntryDto[]>([]);
  const [actors, setActors] = React.useState<Actor[]>([]);
  const [loading, setLoading] = React.useState(true);
  // 실패와 "기록 없음" 은 다른 화면이다 — 같은 회색 빈 화면으로 합치면 다시 시도할 자리를 잃는다
  const [failed, setFailed] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [next, setNext] = React.useState<Cursor>(null);

  const [action, setAction] = React.useState("");
  const [actor, setActor] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const [logType, setLogType] = React.useState("");
  const [range, setRange] = React.useState<string>("30d");

  // 요청 세대 — "더 보기" 가 그사이 바뀐 필터의 목록에 옛 페이지를 붙이지 않게
  const reqRef = React.useRef(0);

  /** from > to 는 항상 0건이다. 조회해서 "없음" 을 보여주면 필터가 틀린 건지 기록이 없는 건지 알 수 없다. */
  const rangeError = from && to && from > to ? t("errRangeOrder") : null;

  /** 목록·내보내기가 **같은** 쿼리를 쓴다 */
  const buildQuery = React.useCallback(
    (cursor?: Cursor) => {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (actor) qs.set("actor", actor);
      // 날짜마다 그날의 로컬 자정을 따로 환산한다 — 오늘 오프셋을 재사용하면 서머타임 경계에서 한 시간 어긋난다
      const f = from ? localDayBoundaryIso(from) : null;
      const tt = to ? localDayBoundaryIso(to, true) : null;
      if (f) qs.set("from", f);
      if (tt) qs.set("to", tt);
      if (cursor) {
        qs.set("before", cursor.ts);
        qs.set("before_id", cursor.id);
      }
      return qs.size > 0 ? `?${qs}` : "";
    },
    [action, actor, from, to]
  );

  const load = React.useCallback(async () => {
    if (rangeError) return;
    const my = ++reqRef.current;
    setLoading(true);
    try {
      const d = await adminApi<ListResponse>(`/api/admin/projects/${projectId}/audit${buildQuery()}`);
      if (my !== reqRef.current) return;
      setEntries(d.entries);
      setNext(d.next);
      setFailed(false);
    } catch (e) {
      if (my !== reqRef.current) return;
      // 빈 배열로 떨어뜨리면 "기록된 변경이 없음" 으로 읽힌다 — 감사 로그에서 그 오해는
      // 위험하다(아무 일도 없었다고 믿게 된다). 토스트는 4초 뒤 사라지므로 화면에 남긴다.
      setEntries([]);
      setNext(null);
      setFailed(true);
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, [projectId, buildQuery, rangeError, errorText, tc]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    (async () => {
      try {
        const d = await adminApi<{ actors: Actor[] }>(`/api/admin/projects/${projectId}/audit/actors`);
        setActors(d.actors);
      } catch {
        // 드롭다운이 비어도 목록 자체는 보여야 한다 — 필터는 부가 기능이다
        setActors([]);
      }
    })();
  }, [projectId]);

  async function loadMore() {
    if (!next || loadingMore) return;
    const my = reqRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<ListResponse>(`/api/admin/projects/${projectId}/audit${buildQuery(next)}`);
      if (my !== reqRef.current) return;
      setEntries((cur) => [...cur, ...d.entries]);
      setNext(d.next);
    } catch (e) {
      if (my === reqRef.current) toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoadingMore(false);
    }
  }

  /** 화면의 필터를 그대로 이어 붙인 내보내기 주소 */
  const auditExportHref = `/api/admin/projects/${projectId}/export/audit${buildQuery()}`;
  const logsExportHref = `/api/admin/projects/${projectId}/export/logs${
    (() => {
      const qs = new URLSearchParams();
      if (logType) qs.set("type", logType);
      const f = from ? localDayBoundaryIso(from) : null;
      const tt = to ? localDayBoundaryIso(to, true) : null;
      if (f) qs.set("from", f);
      if (tt) qs.set("to", tt);
      return qs.size > 0 ? `?${qs}` : "";
    })()
  }`;
  const engagementExportHref = `/api/admin/projects/${projectId}/export/engagement?range=${range}`;

  const df = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }),
    [locale]
  );

  const columns = [
    { label: t("colTime") },
    { label: t("colActor") },
    { label: t("colAction") },
    { label: t("colChanges") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={t("filterAction")}>
              <Select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">{t("allActions")}</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(actionKey(a) as never)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("filterActor")}>
              <Select value={actor} onChange={(e) => setActor(e.target.value)}>
                <option value="">{t("allActors")}</option>
                {actors.map((a: Actor) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("filterFrom")} error={rangeError}>
              <DatePicker value={from} onChange={setFrom} max={to || undefined} placeholder={t("datePlaceholder")} clearLabel={tc("cancel")} />
            </Field>
            <Field label={t("filterTo")}>
              <DatePicker value={to} onChange={setTo} min={from || undefined} placeholder={t("datePlaceholder")} clearLabel={tc("cancel")} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button asChild variant="outline" aria-disabled={!!rangeError}>
              <a href={auditExportHref} download>
                <Download aria-hidden="true" />
                {t("exportAudit")}
              </a>
            </Button>
            <p className={FIELD_HINT_TEXT}>{t("exportLimit", { limit: CSV_ROW_LIMIT })}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-4">
          <h2 className="text-sm font-extrabold text-foreground">{t("reportsTitle")}</h2>
          <p className={FIELD_HINT_TEXT}>{t("reportsHint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={t("logTypeLabel")} hint={t("logRangeHint")}>
              <Select value={logType} onChange={(e) => setLogType(e.target.value)}>
                {LOG_TYPES.map((v) => (
                  <option key={v || "all"} value={v}>
                    {v ? t(`logType.${v}` as never) : t("allTypes")}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button asChild variant="outline" className="w-full">
                <a href={logsExportHref} download>
                  <Download aria-hidden="true" />
                  {t("exportLogs")}
                </a>
              </Button>
            </div>
            <Field label={t("engagementRangeLabel")}>
              <Select value={range} onChange={(e) => setRange(e.target.value)}>
                {ENGAGEMENT_RANGES.map((v) => (
                  <option key={v} value={v}>
                    {t(`range.${v}` as never)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button asChild variant="outline" className="w-full">
                <a href={engagementExportHref} download>
                  <Download aria-hidden="true" />
                  {t("exportEngagement")}
                </a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 표 머리글 배경이 rounded-card 밖으로 새지 않게 — logs-console 과 같은 방식 */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col gap-2 p-3.5">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : failed ? (
            <div className="p-3.5">
              <EmptyState
                icon={AlertTriangle}
                tone="error"
                title={tc("loadFailed")}
                description={tc("loadFailedDesc")}
                action={
                  <Button variant="outline" onClick={() => void load()}>
                    <RefreshCw aria-hidden="true" className="size-4" /> {tc("retry")}
                  </Button>
                }
              />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-3.5">
              <EmptyState icon={ScrollText} title={t("empty")} description={t("emptyHint")} />
            </div>
          ) : (
            <>
              <DataTable label={t("title")} rowCount={entries.length + 1}>
                <TableHeader columns={columns} grid={GRID} />
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id} className={GRID}>
                      <TableCell label={t("colTime")} className="text-sm tabular-nums text-muted-foreground">
                        {df.format(new Date(e.createdAt))}
                      </TableCell>
                      <TableCell label={t("colActor")} className="truncate text-sm font-semibold text-foreground">
                        {e.actorLabel}
                      </TableCell>
                      <TableCell label={t("colAction")} className="flex flex-wrap items-center gap-1 text-sm text-foreground">
                        <span>{t(actionKey(baseAction(e.action)) as never)}</span>
                        {isDenied(e.action) && <Badge variant="danger">{t("denied")}</Badge>}
                        <span className={FIELD_HINT_TEXT}>{e.targetId ?? ""}</span>
                      </TableCell>
                      <TableCell label={t("colChanges")} className="text-sm text-muted-foreground">
                        {e.diff ? (
                          <ul className="flex flex-col gap-0.5">
                            {(Object.entries(e.diff) as [string, DiffEntry][]).map(([field, d]) => (
                              <li key={field} className="break-words">
                                <span className="font-semibold text-foreground">{field}</span>{" "}
                                <span className="line-through">{short(d.before)}</span>{" "}
                                <span aria-hidden="true">→</span> <span>{short(d.after)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
              {next && (
                <div className="flex justify-center border-t border-border p-3.5">
                  <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                    {tc("loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
