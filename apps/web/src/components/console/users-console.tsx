"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Search, Users, Smartphone, MousePointerClick } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi } from "@/lib/admin-client";

/** 서버가 준 복합 커서 — 타임스탬프만으로는 동시각 행이 누락된다 */
type Cursor = { ts: string; id: string } | null;

/** 커서를 쿼리스트링으로 */
function cursorQuery(c: Cursor): string {
  return c ? `before=${encodeURIComponent(c.ts)}&before_id=${encodeURIComponent(c.id)}` : "";
}

type PushUser = {
  id: string;
  externalId: string;
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
  const locale = useLocale();

  const [q, setQ] = React.useState("");
  const [users, setUsers] = React.useState<PushUser[] | null>(null);
  const [next, setNext] = React.useState<Cursor>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const reqRef = React.useRef(0);

  const load = React.useCallback(
    async (search: string) => {
      const my = ++reqRef.current;
      setUsers(null);
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
        toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    },
    [projectId, tc]
  );

  React.useEffect(() => {
    // 타이핑마다 요청하지 않도록 디바운스
    const id = setTimeout(() => load(q), q ? 300 : 0);
    return () => clearTimeout(id);
  }, [q, load]);

  async function loadMore() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await adminApi<{ users: PushUser[]; next: Cursor }>(
        `/api/admin/projects/${projectId}/audience/users?q=${encodeURIComponent(q)}&${cursorQuery(next)}`
      );
      setUsers((cur) => [...(cur ?? []), ...d.users]);
      setNext(d.next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  }

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("usersTitle")} description={t("usersSubtitle")} />

      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("userSearchPlaceholder")}
          aria-label={t("userSearchPlaceholder")}
          className="pl-9"
        />
      </div>

      <Card className="rounded-none">
        <CardContent className="p-0">
          {!users && <div className="space-y-3 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {users && users.length === 0 && <EmptyState icon={Users} title={q ? t("noMatches") : t("noUsers")} />}
          {users && users.length > 0 && (
            <>
              <div className="hidden gap-x-4 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground xl:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_7rem_7rem_10rem] xl:grid">
                <span>{t("colUser")}</span>
                <span>{t("colAttributes")}</span>
                <span>{t("colDevices")}</span>
                <span>{t("colClicks")}</span>
                <span className="text-right">{t("colLastActive")}</span>
              </div>
              <ul className="divide-y divide-border">
                {users.map((u) => {
                  const attrs = Object.entries(u.attributes ?? {}).slice(0, 3);
                  return (
                    <li key={u.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 xl:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_7rem_7rem_10rem] xl:items-center">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-semibold">{u.externalId}</p>
                        <p className="text-xs text-muted-foreground">
                          {[u.locale, u.timezone].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {attrs.length > 0
                          ? attrs.map(([k, v]) => (
                              <Badge key={k} variant="neutral">{k}={String(v)}</Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">{t("noAttributes")}</span>}
                      </div>
                      <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                        <Smartphone aria-hidden="true" className="h-3.5 w-3.5" /> {nf.format(u.deviceCount)}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                        <MousePointerClick aria-hidden="true" className="h-3.5 w-3.5" /> {nf.format(u.clickCount)}
                      </span>
                      <time
                        dateTime={u.lastActiveAt ?? undefined}
                        className="text-xs tabular-nums text-muted-foreground xl:text-right"
                      >
                        {u.lastActiveAt ? df.format(new Date(u.lastActiveAt)) : "—"}
                      </time>
                    </li>
                  );
                })}
              </ul>
              {next && (
                <div className="flex justify-center border-t border-border p-3">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? tc("loading") : tc("loadMore")}
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
