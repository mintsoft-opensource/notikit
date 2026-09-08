import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const RANGES = {
  "24h": { ms: 24 * 3600_000, bucketMs: 3600_000, trunc: "hour" },
  "7d": { ms: 7 * 86400_000, bucketMs: 86400_000, trunc: "day" },
  "30d": { ms: 30 * 86400_000, bucketMs: 86400_000, trunc: "day" },
} as const;
type RangeKey = keyof typeof RANGES;

/** [Web Admin] 프로젝트 분석 — 디바이스/유저 + 기간별(24h/7d/30d) 발송 추이/상태/집계 + 최근 로그 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rangeParam = new URL(req.url).searchParams.get("range") ?? "24h";
  const range: RangeKey = rangeParam in RANGES ? (rangeParam as RangeKey) : "24h";
  const { ms, bucketMs, trunc } = RANGES[range];
  const since = new Date(Date.now() - ms);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const db = getDb();
  const count = async (q: Promise<{ c: number }[]>) => Number((await q)[0]?.c ?? 0);
  const inRange = and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, since));

  const [totalDevices, activeDevices, dau, totalUsers, totalSends, delivered, queued, bucketRows, statusRows, agg, recent, platformRows] =
    await Promise.all([
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(eq(devices.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), eq(devices.isActive, true)))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), gte(devices.lastActiveAt, dayAgo)))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushUsers).where(eq(pushUsers.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`coalesce(sum(success_count),0)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(and(eq(pushLogs.projectId, id), eq(pushLogs.status, "queued")))),
      db
        .select({ bucket: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${pushLogs.createdAt})`, count: sql<number>`count(*)::int` })
        .from(pushLogs)
        .where(inRange)
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db.select({ status: pushLogs.status, count: sql<number>`count(*)::int` }).from(pushLogs).where(inRange).groupBy(pushLogs.status),
      db
        .select({
          sends: sql<number>`count(*)::int`,
          recipients: sql<number>`coalesce(sum(${pushLogs.totalCount}), 0)::int`,
          success: sql<number>`coalesce(sum(${pushLogs.successCount}), 0)::int`,
        })
        .from(pushLogs)
        .where(inRange),
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
      db
        .select({ platform: devices.platform, count: sql<number>`count(*)::int` })
        .from(devices)
        .where(eq(devices.projectId, id))
        .groupBy(devices.platform),
    ]);

  // 빈 버킷 = 0 으로 채움
  const byBucket = new Map(bucketRows.map((r) => [new Date(r.bucket).toISOString(), r.count]));
  const start = new Date(since);
  // date_trunc 는 DB 세션 TZ(UTC) 기준 — 버킷 키도 UTC 로 정렬해야 매칭됨
  if (trunc === "hour") start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const buckets: Array<{ ts: string; count: number }> = [];
  for (let t = start.getTime(); t <= Date.now(); t += bucketMs) {
    const ts = new Date(t).toISOString();
    buckets.push({ ts, count: byBucket.get(ts) ?? 0 });
  }

  return ok({
    range,
    devices: { total: totalDevices, active: activeDevices, dau },
    users: { total: totalUsers },
    messages: {
      total_sends: totalSends,
      total_delivered: delivered,
      sends_24h: agg[0]?.sends ?? 0,
      recipients_24h: agg[0]?.recipients ?? 0,
      success_24h: agg[0]?.success ?? 0,
      queued,
    },
    hourly: buckets,
    statuses: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
    platforms: Object.fromEntries(platformRows.map((r) => [r.platform, r.count])),
    recent,
  });
}
