import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, pushLogs, pushClicks, pushConversions, deviceEvents } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const RANGES = {
  "24h": { ms: 24 * 3600_000, bucketMs: 3600_000, trunc: "hour" },
  "7d": { ms: 7 * 86400_000, bucketMs: 86400_000, trunc: "day" },
  "30d": { ms: 30 * 86400_000, bucketMs: 86400_000, trunc: "day" },
} as const;
type RangeKey = keyof typeof RANGES;
// 프로토타입 체인(constructor/__proto__ 등)이 통과하지 않도록 명시적 허용 목록으로 검증
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** [Web Admin] 프로젝트 분석 — 디바이스/유저 + 기간별(24h/7d/30d) 발송 추이/상태/집계 + 최근 로그 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rangeParam = new URL(req.url).searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "24h";
  const { ms, bucketMs, trunc } = RANGES[range];
  const since = new Date(Date.now() - ms);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const db = getDb();
  const count = async (q: Promise<{ c: number }[]>) => Number((await q)[0]?.c ?? 0);
  const inRange = and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, since));

  const inEventRange = and(eq(deviceEvents.projectId, id), gte(deviceEvents.at, since));

  // 직전 같은 길이의 구간 — KPI 타일의 "전기간 대비" 비교용
  const prevSince = new Date(since.getTime() - ms);
  const prevPromise = db
    .select({
      sends: sql<number>`count(*)::int`,
      recipients: sql<number>`coalesce(sum(${pushLogs.totalCount}), 0)::int`,
      success: sql<number>`coalesce(sum(${pushLogs.successCount}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${pushLogs.clickCount}), 0)::int`,
      clickUsers: sql<number>`coalesce(sum(${pushLogs.clickUserCount}), 0)::int`,
      audienceDevices: sql<number>`coalesce(sum(${pushLogs.audienceDeviceCount}), 0)::int`,
      audienceUsers: sql<number>`coalesce(sum(${pushLogs.audienceUserCount}), 0)::int`,
    })
    .from(pushLogs)
    .where(and(eq(pushLogs.projectId, id), gte(pushLogs.createdAt, prevSince), lt(pushLogs.createdAt, since)));

  /** 전환 집계 — 기간별 건수와 금액 합. 금액 없는 전환은 0 으로 더해진다(합계가 null 이 되지 않게) */
  const conversionAgg = (from: Date, to?: Date) =>
    db
      .select({
        count: sql<number>`count(*)::int`,
        valueCents: sql<number>`coalesce(sum(${pushConversions.valueCents}), 0)::int`,
      })
      .from(pushConversions)
      .where(
        and(
          eq(pushConversions.projectId, id),
          gte(pushConversions.createdAt, from),
          ...(to ? [lt(pushConversions.createdAt, to)] : [])
        )
      );
  const prevConversionPromise = conversionAgg(prevSince, since);

  const [
    totalDevices, activeDevices, dau, totalUsers, totalSends, delivered, queued,
    bucketRows, statusRows, agg, recent, platformRows,
    clickAgg, clickBucketRows, uninstallAgg, uninstallBucketRows, topClicked, conversionRows,
  ] =
    await Promise.all([
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(eq(devices.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), eq(devices.isActive, true)))),
      count(db.select({ c: sql<number>`count(*)` }).from(devices).where(and(eq(devices.projectId, id), gte(devices.lastActiveAt, dayAgo)))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushUsers).where(eq(pushUsers.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`coalesce(sum(success_count),0)` }).from(pushLogs).where(eq(pushLogs.projectId, id))),
      count(db.select({ c: sql<number>`count(*)` }).from(pushLogs).where(and(eq(pushLogs.projectId, id), eq(pushLogs.status, "queued")))),
      db
        // DB 세션 TZ 와 무관하게 UTC 경계로 자름 — 아래 버킷 채우기(UTC)와 키가 일치해야 함
        .select({
          bucket: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${pushLogs.createdAt} at time zone 'UTC') at time zone 'UTC'`,
          count: sql<number>`count(*)::int`,
        })
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
      // 클릭 퍼널 — 분자/분모를 각각 짝이 맞는 것끼리 합산한다.
      // clickCount(디바이스) ↔ audienceDeviceCount, clickUserCount(유저) ↔ audienceUserCount
      db
        .select({
          clicks: sql<number>`coalesce(sum(${pushLogs.clickCount}), 0)::int`,
          clickUsers: sql<number>`coalesce(sum(${pushLogs.clickUserCount}), 0)::int`,
          audienceDevices: sql<number>`coalesce(sum(${pushLogs.audienceDeviceCount}), 0)::int`,
          audienceUsers: sql<number>`coalesce(sum(${pushLogs.audienceUserCount}), 0)::int`,
        })
        .from(pushLogs)
        .where(inRange),
      db
        .select({
          bucket: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${pushClicks.clickedAt} at time zone 'UTC') at time zone 'UTC'`,
          count: sql<number>`count(*)::int`,
        })
        .from(pushClicks)
        .where(and(eq(pushClicks.projectId, id), gte(pushClicks.clickedAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ event: deviceEvents.event, count: sql<number>`count(*)::int` })
        .from(deviceEvents)
        .where(inEventRange)
        .groupBy(deviceEvents.event),
      db
        .select({
          bucket: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${deviceEvents.at} at time zone 'UTC') at time zone 'UTC'`,
          count: sql<number>`count(*)::int`,
        })
        .from(deviceEvents)
        .where(and(inEventRange, eq(deviceEvents.event, "uninstalled")))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      // 클릭 상위 발송 — 어떤 메시지가 실제로 먹혔는지
      db
        .select({
          id: pushLogs.id,
          title: pushLogs.title,
          type: pushLogs.type,
          clickCount: pushLogs.clickCount,
          clickUserCount: pushLogs.clickUserCount,
          audienceUserCount: pushLogs.audienceUserCount,
          audienceDeviceCount: pushLogs.audienceDeviceCount,
          createdAt: pushLogs.createdAt,
        })
        .from(pushLogs)
        .where(and(inRange, sql`${pushLogs.clickCount} > 0`))
        .orderBy(desc(pushLogs.clickCount))
        .limit(5),
      conversionAgg(since),
    ]);

  // 빈 버킷 = 0 으로 채움
  const byBucket = new Map(bucketRows.map((r) => [new Date(r.bucket).toISOString(), r.count]));
  const start = new Date(since);
  // date_trunc 는 DB 세션 TZ(UTC) 기준 — 버킷 키도 UTC 로 정렬해야 매칭됨
  if (trunc === "hour") start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const byClick = new Map(clickBucketRows.map((r) => [new Date(r.bucket).toISOString(), r.count]));
  const byUninstall = new Map(uninstallBucketRows.map((r) => [new Date(r.bucket).toISOString(), r.count]));

  const buckets: Array<{ ts: string; count: number }> = [];
  const clickBuckets: Array<{ ts: string; count: number }> = [];
  const uninstallBuckets: Array<{ ts: string; count: number }> = [];
  for (let t = start.getTime(); t <= Date.now(); t += bucketMs) {
    const ts = new Date(t).toISOString();
    buckets.push({ ts, count: byBucket.get(ts) ?? 0 });
    clickBuckets.push({ ts, count: byClick.get(ts) ?? 0 });
    uninstallBuckets.push({ ts, count: byUninstall.get(ts) ?? 0 });
  }

  const c = clickAgg[0];
  const p = (await prevPromise)[0];
  const conv = conversionRows[0];
  const prevConv = (await prevConversionPromise)[0];
  const uninstalls = Object.fromEntries(uninstallAgg.map((r) => [r.event, r.count]));
  /** 분모가 0이면 비율은 정의되지 않는다 — 0% 로 위장하지 않고 null 로 낸다 */
  const rate = (num: number, den: number) => (den > 0 ? num / den : null);

  return ok({
    range,
    devices: { total: totalDevices, active: activeDevices, dau },
    users: { total: totalUsers },
    messages: {
      total_sends: totalSends,
      total_delivered: delivered,
      // range 스코프 집계 (기간에 따라 24h/7d/30d) — 전체 누적은 total_*
      sends: agg[0]?.sends ?? 0,
      recipients: agg[0]?.recipients ?? 0,
      success: agg[0]?.success ?? 0,
      queued,
    },
    buckets,
    clicks: {
      // 디바이스 단위(clicks/audience_devices)와 유저 단위(click_users/audience_users)를
      // 섞어 쓰면 100% 를 넘는 비율이 나온다. 짝을 맞춰 쓴다.
      clicks: c?.clicks ?? 0,
      click_users: c?.clickUsers ?? 0,
      audience_devices: c?.audienceDevices ?? 0,
      audience_users: c?.audienceUsers ?? 0,
      device_rate: rate(c?.clicks ?? 0, c?.audienceDevices ?? 0),
      user_rate: rate(c?.clickUsers ?? 0, c?.audienceUsers ?? 0),
      buckets: clickBuckets,
      top: topClicked,
    },
    // 전환 — 클릭에 귀속된 앱 안 행동. 금액은 최소 화폐 단위(원/센트)라 화면이 단위를 밝혀야 한다.
    conversions: { count: conv?.count ?? 0, value_cents: conv?.valueCents ?? 0 },
    devices_lifecycle: {
      uninstalled: uninstalls.uninstalled ?? 0,
      reinstalled: uninstalls.reinstalled ?? 0,
      net: (uninstalls.reinstalled ?? 0) - (uninstalls.uninstalled ?? 0),
      buckets: uninstallBuckets,
    },
    // 직전 같은 길이 구간의 같은 집계 — 화면이 증감을 계산한다
    previous: {
      sends: p?.sends ?? 0,
      recipients: p?.recipients ?? 0,
      success: p?.success ?? 0,
      clicks: p?.clicks ?? 0,
      click_users: p?.clickUsers ?? 0,
      audience_devices: p?.audienceDevices ?? 0,
      audience_users: p?.audienceUsers ?? 0,
      device_rate: rate(p?.clicks ?? 0, p?.audienceDevices ?? 0),
      user_rate: rate(p?.clickUsers ?? 0, p?.audienceUsers ?? 0),
      conversions: prevConv?.count ?? 0,
      conversion_value_cents: prevConv?.valueCents ?? 0,
    },
    statuses: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
    platforms: Object.fromEntries(platformRows.map((r) => [r.platform, r.count])),
    recent,
  });
}
