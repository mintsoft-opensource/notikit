import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** 아직 배달되지 않은 상태들 */
const PENDING = ["queued", "processing", "scheduled"] as const;
const LIMIT = 100;

/**
 * [Web Admin] 프로젝트 발송 큐 — 대기·처리중·예약 건과 대기 시간.
 *
 * 로그 화면은 "무엇이 나갔는가"를 보지만, 여기는 "무엇이 아직 안 나갔는가"를 본다.
 * 워커가 멈췄거나 예약이 밀려 있을 때 그 사실이 드러나야 한다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();

  const [counts, rows] = await Promise.all([
    db
      .select({
        status: pushLogs.status,
        count: sql<number>`count(*)::int`,
        // 가장 오래된 건의 대기 시간(초). 워커가 죽으면 이 값이 계속 자란다.
        oldestSec: sql<number>`coalesce(extract(epoch from (now() - min(${pushLogs.createdAt})))::int, 0)`,
      })
      .from(pushLogs)
      .where(and(eq(pushLogs.projectId, id), inArray(pushLogs.status, [...PENDING])))
      .groupBy(pushLogs.status),

    db
      .select({
        id: pushLogs.id,
        title: pushLogs.title,
        type: pushLogs.type,
        target: pushLogs.target,
        status: pushLogs.status,
        totalCount: pushLogs.totalCount,
        scheduledAt: pushLogs.scheduledAt,
        lockedAt: pushLogs.lockedAt,
        createdAt: pushLogs.createdAt,
      })
      .from(pushLogs)
      .where(and(eq(pushLogs.projectId, id), inArray(pushLogs.status, [...PENDING])))
      // 예약은 나갈 순서대로, 나머지는 오래 기다린 순서대로 — 둘 다 "다음에 처리될 것"이 위로
      .orderBy(asc(pushLogs.scheduledAt), asc(pushLogs.createdAt))
      .limit(LIMIT + 1),
  ]);

  const byStatus = new Map(counts.map((c) => [c.status, c]));
  const hasMore = rows.length > LIMIT;

  return ok({
    summary: {
      queued: byStatus.get("queued")?.count ?? 0,
      processing: byStatus.get("processing")?.count ?? 0,
      scheduled: byStatus.get("scheduled")?.count ?? 0,
      // 예약은 "대기"가 아니다 — 아직 시각이 안 됐을 뿐이라 지연 지표에서 뺀다
      oldestQueuedSec: byStatus.get("queued")?.oldestSec ?? null,
    },
    items: hasMore ? rows.slice(0, LIMIT) : rows,
    truncated: hasMore,
  });
}
