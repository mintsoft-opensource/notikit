import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 프로젝트 분석 — 디바이스/유저/발송 통계 + DAU */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const db = getDb();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const count = async (q: Promise<{ c: number }[]>) => Number((await q)[0]?.c ?? 0);

  const [totalDevices, activeDevices, dau, totalUsers, totalSends, delivered] = await Promise.all([
    count(db.select({ c: sql<number>`count(*)` }).from(devices).where(eq(devices.projectId, id))),
    count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), eq(devices.isActive, true)))),
    count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), gte(devices.lastActiveAt, dayAgo)))),
    count(db.select({ c: sql<number>`count(*)` }).from(pushUsers).where(eq(pushUsers.projectId, id))),
    count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
    count(db.select({ c: sql<number>`coalesce(sum(success_count),0)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
  ]);

  return ok({
    devices: { total: totalDevices, active: activeDevices, dau },
    users: { total: totalUsers },
    messages: { total_sends: totalSends, total_delivered: delivered },
  });
}
