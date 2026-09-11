import { and, desc, eq, gte, lt } from "drizzle-orm";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

const TYPES = ["single", "topic", "broadcast", "segment"] as const;
type LogType = (typeof TYPES)[number];
const LIMIT = 50;

/**
 * `?from=`/`?to=` 파싱. 날짜(YYYY-MM-DD)와 ISO 둘 다 받는다.
 *
 * 날짜만 온 경우 **어느 타임존의 하루인가**가 문제다. 서버에서 `new Date("2026-09-11")`
 * 류로 해석하면 서버 로컬(대개 UTC) 기준이 되어, 서울 사용자가 9월 11일을 골라도
 * 실제로는 9/11 09:00~9/12 09:00 KST 가 조회된다 — 화면에 9월 11일 00:30 으로
 * 보이는 건이 빠지고 9월 12일 08:30 건이 들어온다.
 *
 * 그래서 오프셋을 함께 받는다(`?tz_offset=` 분 단위, JS `getTimezoneOffset()` 부호).
 * 없으면 UTC 기준으로 둔다 — 예전 동작과 같다.
 */
function parseRange(url: URL): { from: Date | null; to: Date | null } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const rawOffset = Number(url.searchParams.get("tz_offset"));
  // getTimezoneOffset 은 UTC 기준 "뒤처진 분"이라 부호가 반대다(KST = -540)
  const offsetMin = Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 900 ? rawOffset : 0;

  const read = (key: string, endExclusive: boolean): Date | null => {
    const raw = url.searchParams.get(key);
    if (!raw) return null;
    if (!dateOnly.test(raw)) {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const [y, m, day] = raw.split("-").map(Number);
    // 사용자의 그 날 00:00 을 UTC 순간으로 환산
    const ms = Date.UTC(y, m - 1, day + (endExclusive ? 1 : 0)) + offsetMin * 60_000;
    return new Date(ms);
  };
  return { from: read("from", false), to: read("to", true) };
}

/** [Web Admin] 프로젝트 푸시 로그. type 으로 단건/토픽 등을 나눠 볼 수 있다. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type");
  // 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
  const type = TYPES.includes(typeParam as LogType) ? (typeParam as LogType) : null;
  const cursor = parseCursor(url);
  const { from, to } = parseRange(url);

  const conds = [eq(pushLogs.projectId, id)];
  if (type) conds.push(eq(pushLogs.type, type));
  if (from) conds.push(gte(pushLogs.createdAt, from));
  if (to) conds.push(lt(pushLogs.createdAt, to));
  if (cursor) conds.push(beforeCursor(pushLogs.createdAt, pushLogs.id, cursor));

  const db = getDb();
  // 요약 필드만 (수신자/본문/데이터/딥링크 등 민감정보 노출 방지)
  const rows = await db
    .select({
      id: pushLogs.id,
      title: pushLogs.title,
      type: pushLogs.type,
      status: pushLogs.status,
      totalCount: pushLogs.totalCount,
      successCount: pushLogs.successCount,
      failureCount: pushLogs.failureCount,
      // 토픽/세그먼트 이름, 단건의 external_id
      target: pushLogs.target,
      // 클릭률 = clickUserCount / audienceUserCount (분모는 발송 시점 스냅샷)
      audienceUserCount: pushLogs.audienceUserCount,
      audienceDeviceCount: pushLogs.audienceDeviceCount,
      clickCount: pushLogs.clickCount,
      clickUserCount: pushLogs.clickUserCount,
      variantStats: pushLogs.variantStats,
      createdAt: pushLogs.createdAt,
      cursorTs: cursorExpr(pushLogs.createdAt),
    })
    .from(pushLogs)
    .where(and(...conds))
    .orderBy(desc(pushLogs.createdAt), desc(pushLogs.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const logs = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({ logs: logs.map(({ cursorTs: _cursorTs, ...l }) => l), next: nextCursor(logs, hasMore) });
}
