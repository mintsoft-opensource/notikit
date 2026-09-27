import { and, eq, inArray, sql } from "drizzle-orm";
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
        // 취소 확인창이 "이미 나간 수" 를 **누르기 전에** 보여 주려면 목록에 함께 있어야 한다
        successCount: pushLogs.successCount,
        failureCount: pushLogs.failureCount,
        scheduledAt: pushLogs.scheduledAt,
        lockedAt: pushLogs.lockedAt,
        createdAt: pushLogs.createdAt,
      })
      .from(pushLogs)
      .where(and(eq(pushLogs.projectId, id), inArray(pushLogs.status, [...PENDING])))
      // 막힌 건(대기·처리중)을 **먼저** 보여준다.
      //
      // scheduled_at 오름차순만 쓰면 Postgres 기본이 NULLS LAST 라, 예약이 없는
      // 대기 건이 1년 뒤 예약보다도 뒤로 밀린다. 예약이 LIMIT 을 채우면 정작
      // 이 화면이 존재하는 이유인 "워커가 멈춰 쌓인 건"이 한 건도 안 보인다.
      .orderBy(
        sql`(${pushLogs.scheduledAt} is not null)`,
        sql`coalesce(${pushLogs.scheduledAt}, ${pushLogs.createdAt})`
      )
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
