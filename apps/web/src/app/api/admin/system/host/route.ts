import { sql, eq, and, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth } from "@/lib/authz";
import { collectHostMetrics } from "@/lib/system-metrics";

export const dynamic = "force-dynamic";

/** [Web Admin] 호스트 실시간 메트릭 — CPU/메모리/네트워크/이벤트루프/DB 지연 + org 스코프 큐 상태 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);

  const db = getDb();

  const t0 = performance.now();
  await db.execute(sql`select 1`);
  const dbLatencyMs = performance.now() - t0;

  const idRows = auth.ctx.superadmin
    ? await db.select({ id: projects.id }).from(projects)
    : await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, auth.ctx.orgId!));
  const ids = idRows.map((r) => r.id);

  const queueRows =
    ids.length === 0
      ? []
      : await db
          .select({
            status: pushLogs.status,
            count: sql<number>`count(*)::int`,
            oldest: sql<string | null>`min(${pushLogs.createdAt})`,
          })
          .from(pushLogs)
          .where(and(inArray(pushLogs.projectId, ids), inArray(pushLogs.status, ["queued", "processing", "scheduled"])))
          .groupBy(pushLogs.status);

  const byStatus = new Map(queueRows.map((r) => [r.status, r]));
  const oldestQueued = byStatus.get("queued")?.oldest;

  const host = await collectHostMetrics();

  return ok({
    host,
    db: { latencyMs: dbLatencyMs },
    queue: {
      queued: byStatus.get("queued")?.count ?? 0,
      processing: byStatus.get("processing")?.count ?? 0,
      scheduled: byStatus.get("scheduled")?.count ?? 0,
      oldestQueuedSec: oldestQueued ? Math.max(0, (Date.now() - new Date(oldestQueued).getTime()) / 1000) : null,
    },
    at: new Date().toISOString(),
  });
}
