"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Search, Users, Smartphone, MousePointerClick } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { cursorQuery, type Cursor } from "@/lib/cursor-query";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { useNumberFormat } from "@/lib/number-format";

/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */


type PushUser = {
  id: string;
  externalId: string;
  name: string | null;
  attributes: Record<string, unknown> | null;
  phone: string | null;
  locale: string | null;
  timezone: string | null;
  createdAt: string;
  deviceCount: number;
  clickCount: number;
  lastActiveAt: string | null;
};

/** 유저 목록 — external_id 검색 + 디바이스/클릭 집계. 유저 중심 제품의 기본 조회 화면. */
export function UsersConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const locale = useLocale();

  const [q, setQ] = React.useState("");
  const [users, setUsers] = React.useState<PushUser[] | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // 요청 세대 — 초기 로드가 올리고 "더 보기"는 같은 세대인지만 본다
  const reqRef = React.useRef(0);
  // 지금 목록을 만든 검색어 — 입력창의 q 는 디바운스 중이라 목록과 다를 수 있다
  const loadedQueryRef = React.useRef("");

  const load = React.useCallback(
    async (search: string) => {
      const my = ++reqRef.current;
      loadedQueryRef.current = search;
      setUsers(null);
      setNext(null);
      setLoadingMore(false);
      try {
        const d = await adminApi<{ users: PushUser[]; next: Cursor }>(
          `/api/admin/projects/${projectId}/audience/users?q=${encodeURIComponent(search)}`
        );
        if (my !== reqRef.current) return; // 늦게 온 옛 응답이 최신 결과를 덮지 않게
        setUsers(d.users);
        setNext(d.next);
      } catch (e) {
        if (my !== reqRef.current) return;
        setUsers([]);
        toast.error(errorText(e, tc("loadFailed")));
      }
    },
    [projectId, tc, errorText]
  );

  React.useEffect(() => {
    // 타이핑마다 요청하지 않도록 디바운스
    const id = setTimeout(() => load(q), q ? 300 : 0);
    return () => clearTimeout(id);
  }, [q, load]);

  async function loadMore() {
    if (!next || loadingMore) return;
    // 세대를 올리지 않고 붙잡아 둔다 — 그사이 검색어가 바뀌면 옛 검색의 다음 페이지를 새 목록에 붙이지 않는다
    const my = reqRef.current;
    setLoadingMore(true);
    try {
      const d = await adminApi<{ users: PushUser[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/users?q=${encodeURIComponent(loadedQueryRef.current)}&${cursorQuery(next)}`
      );
      if (my !== reqRef.current) return;
      setUsers((cur) => [...(cur ?? []), ...d.users]);
      setNext(d.next);
    } catch (e) {
      if (my !== reqRef.current) return;
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoadingMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = useNumberFormat();

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("usersTitle")} description={t("usersSubtitle")} />

      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("userSearchPlaceholder")}
          aria-label={t("userSearchPlaceholder")}
          className="ps-9"
        />
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!users && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {users && users.length === 0 && <EmptyState icon={Users} title={q ? t("noMatches") : t("noUsers")} />}
          {users && users.length > 0 && (
            <>
              <DataTable label={t("usersTitle")} rowCount={users.length + 1}>
              <TableHeader
                grid="xl:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_7rem_7rem_10rem]"
                columns={[
                  { label: t("colUser") },
                  { label: t("colAttributes") },
                  { label: t("colDevices"), align: "end" },
                  { label: t("colClicks"), align: "end" },
                  { label: t("colLastActive"), align: "end" },
                ]}
              />
              <TableBody>
                {users.map((u) => {
                  const attrs = Object.entries(u.attributes ?? {}).slice(0, 3);
                  return (
                    <TableRow key={u.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_7rem_7rem_10rem] xl:items-center">
                      <TableCell label={t("colUser")} className="min-w-0">
                        {u.name && <p className="truncate text-sm font-semibold">{u.name}</p>}
                        <p className={u.name ? "truncate font-mono text-xs text-muted-foreground" : "truncate font-mono text-sm font-semibold"}>{u.externalId}</p>
                        <p className={FIELD_HINT_TEXT}>
                          {[u.locale, u.timezone].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </TableCell>
                      <TableCell label={t("colAttributes")} className="flex min-w-0 flex-wrap gap-1">
                        {attrs.length > 0
                          ? attrs.map(([k, v]) => (
                              <Badge key={k} variant="neutral">{k}={String(v)}</Badge>
                            ))
                          : <span className={FIELD_HINT_TEXT}>{t("noAttributes")}</span>}
                      </TableCell>
                      <TableCell label={t("colDevices")} className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground xl:justify-end">
                        <Smartphone aria-hidden="true" className="size-4" /> {nf.format(u.deviceCount)}
                      </TableCell>
                      <TableCell label={t("colClicks")} className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground xl:justify-end">
                        <MousePointerClick aria-hidden="true" className="size-4" /> {nf.format(u.clickCount)}
                      </TableCell>
                      <TableCell
                        label={t("colLastActive")}
                        className="text-xs tabular-nums text-muted-foreground xl:text-end"
                      >
                        {u.lastActiveAt ? df.format(new Date(u.lastActiveAt)) : "—"}
                      </TableCell>
                    </TableRow>
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
