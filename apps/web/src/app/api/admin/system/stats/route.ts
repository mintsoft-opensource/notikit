import { sql, eq, and, gte, inArray, count as countFn } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, pushLogs, devices, pushUsers, webhookDeliveries, webhooks } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 시스템 뷰어 집계 — 24h 발송 추이/상태/프로젝트별 + 현재 큐 깊이. org 스코프. */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);

  const db = getDb();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const scoped = auth.ctx.superadmin
    ? await db.select({ id: projects.id, name: projects.name }).from(projects)
    : await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.orgId, auth.ctx.orgId!));
  const ids = scoped.map((p) => p.id);
  const nameById = new Map(scoped.map((p) => [p.id, p.name]));

  if (ids.length === 0) {
    return ok({
      totals: { sends24h: 0, recipients24h: 0, success24h: 0, queued: 0, activeDevices: 0, users: 0 },
      hourly: [],
      statuses: {},
      topProjects: [],
      webhooks24h: { delivered: 0, failed: 0, pending: 0 },
    });
  }

  const [hourlyRows, statusRows, queuedRow, deviceRow, userRow, topRows, whRows] = await Promise.all([
    db
      .select({
        hour: sql<string>`date_trunc('hour', ${pushLogs.createdAt})`,
        count: sql<number>`count(*)::int`,
        recipients: sql<number>`coalesce(sum(${pushLogs.totalCount}), 0)::int`,
        success: sql<number>`coalesce(sum(${pushLogs.successCount}), 0)::int`,
      })
      .from(pushLogs)
      .where(and(inArray(pushLogs.projectId, ids), gte(pushLogs.createdAt, dayAgo)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ status: pushLogs.status, count: sql<number>`count(*)::int` })
      .from(pushLogs)
      .where(and(inArray(pushLogs.projectId, ids), gte(pushLogs.createdAt, dayAgo)))
      .groupBy(pushLogs.status),
    db
      .select({ count: countFn() })
      .from(pushLogs)
      .where(and(inArray(pushLogs.projectId, ids), eq(pushLogs.status, "queued"))),
    db
      .select({ count: countFn() })
      .from(devices)
      .where(and(inArray(devices.projectId, ids), eq(devices.isActive, true))),
    db.select({ count: countFn() }).from(pushUsers).where(inArray(pushUsers.projectId, ids)),
    db
      .select({ projectId: pushLogs.projectId, count: sql<number>`count(*)::int` })
      .from(pushLogs)
      .where(and(inArray(pushLogs.projectId, ids), gte(pushLogs.createdAt, dayAgo)))
      .groupBy(pushLogs.projectId)
      .orderBy(sql`count(*) desc`)
      .limit(5),
    db
      .select({ status: webhookDeliveries.status, count: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(and(inArray(webhooks.projectId, ids), gte(webhookDeliveries.createdAt, dayAgo)))
      .groupBy(webhookDeliveries.status),
  ]);

  // 24개 시간 버킷 채우기 (빈 시간대 = 0)
  const byHour = new Map(hourlyRows.map((r) => [new Date(r.hour).toISOString(), r]));
  const hourly: Array<{ ts: string; count: number; recipients: number; success: number }> = [];
  const start = new Date(dayAgo);
  start.setMinutes(0, 0, 0);
  for (let i = 0; i < 25; i++) {
    const ts = new Date(start.getTime() + i * 3600_000).toISOString();
    const row = byHour.get(ts);
    hourly.push({ ts, count: row?.count ?? 0, recipients: row?.recipients ?? 0, success: row?.success ?? 0 });
  }

  const statuses = Object.fromEntries(statusRows.map((r) => [r.status, r.count]));
  const sends24h = hourlyRows.reduce((a, r) => a + r.count, 0);
  const recipients24h = hourlyRows.reduce((a, r) => a + r.recipients, 0);
  const success24h = hourlyRows.reduce((a, r) => a + r.success, 0);
  const wh = Object.fromEntries(whRows.map((r) => [r.status, r.count]));

  return ok({
    totals: {
      sends24h,
      recipients24h,
      success24h,
      queued: Number(queuedRow[0]?.count ?? 0),
      activeDevices: Number(deviceRow[0]?.count ?? 0),
      users: Number(userRow[0]?.count ?? 0),
    },
    hourly,
    statuses,
    topProjects: topRows.map((r) => ({ id: r.projectId, name: nameById.get(r.projectId) ?? r.projectId, count: r.count })),
    webhooks24h: { delivered: wh.delivered ?? 0, failed: wh.failed ?? 0, pending: wh.pending ?? 0 },
  });
}
