import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushClicks, pushLogs } from "@/db/schema";
import { logSentAtSql } from "@/lib/log-sent-at";
import { fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { beforeCursor, cursorExpr, type Cursor } from "@/lib/keyset";
import { CSV_PAGE_SIZE, CSV_ROW_LIMIT, csvHeaders, csvStream, csvTimestamp, pagedRows } from "@/lib/csv-export";

export const dynamic = "force-dynamic";

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type RangeKey = keyof typeof RANGES;
// 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

const HEADER = [
  "clicked_at",
  "log_id",
  "log_title",
  "log_type",
  "platform",
  "variant",
  "seconds_to_read",
  "dow_utc",
  "hour_utc",
] as const;

/**
 * [Web Admin] 참여 CSV 내보내기 — 참여 화면의 히트맵·읽기지연·플랫폼이 모두 여기서 나온 클릭 행이다.
 *
 * 집계표가 아니라 **원본 행**을 준다: 화면은 UTC 기준 7×24 격자로 접어 보여주지만,
 * 운영자가 스프레드시트에서 자기 기준으로 다시 접을 수 있어야 내보내기에 의미가 있다.
 * 기간(`?range=7d|30d|90d`)은 화면의 선택과 같은 값이다.
 *
 * 기기 토큰·외부 사용자 id 는 넣지 않는다 — 참여 분석에 필요 없고, 내보낸 파일은
 * 콘솔의 접근 통제를 벗어나 메일·메신저로 돌아다닌다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rangeParam = new URL(req.url).searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "30d";
  const since = new Date(Date.now() - RANGES[range] * 86_400_000);
  const db = getDb();

  const rows = pagedRows(
    async (cursor: Cursor | null) => {
      const conds = [eq(pushClicks.projectId, id), gte(pushClicks.clickedAt, since)];
      if (cursor) conds.push(beforeCursor(pushClicks.clickedAt, pushClicks.id, cursor));
      const page = await db
        .select({
          id: pushClicks.id,
          logId: pushClicks.logId,
          title: pushLogs.title,
          type: pushLogs.type,
          platform: pushClicks.platform,
          variant: pushClicks.variant,
          secondsToRead: sql<number | null>`extract(epoch from (${pushClicks.clickedAt} - ${logSentAtSql()}))::int`,
          dow: sql<number>`extract(dow from ${pushClicks.clickedAt} at time zone 'UTC')::int`,
          hour: sql<number>`extract(hour from ${pushClicks.clickedAt} at time zone 'UTC')::int`,
          clickedAt: pushClicks.clickedAt,
          cursorTs: cursorExpr(pushClicks.clickedAt),
        })
        .from(pushClicks)
        .innerJoin(pushLogs, eq(pushClicks.logId, pushLogs.id))
        .where(and(...conds))
        .orderBy(desc(pushClicks.clickedAt), desc(pushClicks.id))
        .limit(CSV_PAGE_SIZE);
      const last = page[page.length - 1];
      return { rows: page, next: page.length === CSV_PAGE_SIZE && last ? { ts: last.cursorTs, id: last.id } : null };
    },
    (r) => [
      csvTimestamp(r.clickedAt),
      r.logId,
      r.title,
      r.type,
      r.platform ?? "unknown",
      r.variant,
      // 음수는 기기 시계 오차다 — 화면과 같게 0 으로 눌러 둔다
      r.secondsToRead === null ? "" : Math.max(0, r.secondsToRead),
      r.dow,
      r.hour,
    ]
  );

  return new Response(csvStream({ header: HEADER, rows, limit: CSV_ROW_LIMIT }), {
    headers: csvHeaders(`notikit-engagement-${range}`),
  });
}
