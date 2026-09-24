import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { parseDateRange } from "@/lib/audit";
import { beforeCursor, cursorExpr, type Cursor } from "@/lib/keyset";
import { CSV_PAGE_SIZE, CSV_ROW_LIMIT, csvHeaders, csvStream, csvTimestamp, pagedRows } from "@/lib/csv-export";

export const dynamic = "force-dynamic";

const TYPES = ["single", "multi", "topic", "broadcast", "segment"] as const;
type LogType = (typeof TYPES)[number];

const HEADER = [
  "created_at",
  "id",
  "type",
  "title",
  "target",
  "status",
  "total",
  "success",
  "failure",
  "audience_users",
  "audience_devices",
  "clicks",
  "click_users",
  "read_rate",
  "is_test",
] as const;

/**
 * [Web Admin] 발송 로그 CSV 내보내기.
 *
 * 필터(`?type=`, `?from=`, `?to=`, `?tz_offset=`)는 발송 로그 화면과 같은 규칙이다 —
 * 화면에서 9월만 보고 있는데 파일에는 전체가 담기면 그건 다른 자료다.
 * 본문·수신자·딥링크는 내보내지 않는다(목록 API 와 같은 이유: 민감정보).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type");
  // 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
  const type = TYPES.includes(typeParam as LogType) ? (typeParam as LogType) : null;
  const { from, to } = parseDateRange(url);
  const db = getDb();

  const rows = pagedRows(
    async (cursor: Cursor | null) => {
      const conds = [eq(pushLogs.projectId, id)];
      // 화면의 "단건 푸시" 는 single + multi 를 함께 본다
      if (type === "single") conds.push(inArray(pushLogs.type, ["single", "multi"]));
      else if (type) conds.push(eq(pushLogs.type, type));
      if (from) conds.push(gte(pushLogs.createdAt, from));
      if (to) conds.push(lt(pushLogs.createdAt, to));
      if (cursor) conds.push(beforeCursor(pushLogs.createdAt, pushLogs.id, cursor));

      const page = await db
        .select({
          id: pushLogs.id,
          type: pushLogs.type,
          title: pushLogs.title,
          target: pushLogs.target,
          status: pushLogs.status,
          totalCount: pushLogs.totalCount,
          successCount: pushLogs.successCount,
          failureCount: pushLogs.failureCount,
          audienceUserCount: pushLogs.audienceUserCount,
          audienceDeviceCount: pushLogs.audienceDeviceCount,
          clickCount: pushLogs.clickCount,
          clickUserCount: pushLogs.clickUserCount,
          isTest: pushLogs.isTest,
          createdAt: pushLogs.createdAt,
          cursorTs: cursorExpr(pushLogs.createdAt),
        })
        .from(pushLogs)
        .where(and(...conds))
        .orderBy(desc(pushLogs.createdAt), desc(pushLogs.id))
        .limit(CSV_PAGE_SIZE);
      const last = page[page.length - 1];
      return { rows: page, next: page.length === CSV_PAGE_SIZE && last ? { ts: last.cursorTs, id: last.id } : null };
    },
    (r) => [
      csvTimestamp(r.createdAt),
      r.id,
      r.type,
      r.title,
      r.target,
      r.status,
      r.totalCount,
      r.successCount,
      r.failureCount,
      r.audienceUserCount,
      r.audienceDeviceCount,
      r.clickCount,
      r.clickUserCount,
      // 분모가 0 이면 비율이 없다 — 0% 로 적으면 "아무도 안 읽었다" 로 읽힌다
      r.audienceUserCount > 0 ? (r.clickUserCount / r.audienceUserCount).toFixed(4) : "",
      r.isTest ? "true" : "false",
    ]
  );

  return new Response(csvStream({ header: HEADER, rows, limit: CSV_ROW_LIMIT }), {
    headers: csvHeaders(`notikit-logs${type ? `-${type}` : ""}`),
  });
}
