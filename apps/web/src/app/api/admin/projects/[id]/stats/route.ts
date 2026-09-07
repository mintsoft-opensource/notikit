import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 프로젝트 분석 — 디바이스/유저/발송 통계 + DAU + 24h 추이/상태/최근 로그 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const db = getDb();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const count = async (q: Promise<{ c: number }[]>) => Number((await q)[0]?.c ?? 0);

  const [totalDevices, activeDevices, dau, totalUsers, totalSends, delivered, queued, hourlyRows, statusRows, day24, recent] =
    await Promise.all([
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(eq(devices.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), eq(devices.isActive, true)))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), gte(devices.lastActiveAt, dayAgo)))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushUsers).where(eq(pushUsers.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`coalesce(sum(success_count),0)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(and(eq(pushLogs.projectId, id), eq(pushLogs.status, "queued")))),
      db
        .select({ hour: sql<string>`date_trunc('hour', ${pushLogs.createdAt})`, count: sql<number>`count(*)::int` })
        .from(pushLogs)
        .where(and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, dayAgo)))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ status: pushLogs.status, count: sql<number>`count(*)::int` })
        .from(pushLogs)
        .where(and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, dayAgo)))
        .groupBy(pushLogs.status),
      db
        .select({
          sends: sql<number>`count(*)::int`,
          recipients: sql<number>`coalesce(sum(${pushLogs.totalCount}), 0)::int`,
          success: sql<number>`coalesce(sum(${pushLogs.successCount}), 0)::int`,
        })
        .from(pushLogs)
        .where(and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, dayAgo))),
      db
        .select({
          id: pushLogs.id,
          title: pushLogs.title,
          type: pushLogs.type,
          status: pushLogs.status,
          totalCount: pushLogs.totalCount,
          successCount: pushLogs.successCount,
          createdAt: pushLogs.createdAt,
        })
        .from(pushLogs)
        .where(eq(pushLogs.projectId, id))
        .orderBy(desc(pushLogs.createdAt))
        .limit(5),
    ]);

  // 24개 시간 버킷 (빈 시간대 = 0)
  const byHour = new Map(hourlyRows.map((r) => [new Date(r.hour).toISOString(), r.count]));
  const start = new Date(dayAgo);
  start.setMinutes(0, 0, 0);
  const hourly: Array<{ ts: string; count: number }> = [];
  for (let i = 0; i < 25; i++) {
    const ts = new Date(start.getTime() + i * 3600_000).toISOString();
    hourly.push({ ts, count: byHour.get(ts) ?? 0 });
  }

  return ok({
    devices: { total: totalDevices, active: activeDevices, dau },
    users: { total: totalUsers },
    messages: {
      total_sends: totalSends,
      total_delivered: delivered,
      sends_24h: day24[0]?.sends ?? 0,
      recipients_24h: day24[0]?.recipients ?? 0,
      success_24h: day24[0]?.success ?? 0,
      queued,
    },
    hourly,
    statuses: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
    recent,
  });
}
