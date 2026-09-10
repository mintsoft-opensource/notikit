import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { deviceActivity } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type RangeKey = keyof typeof RANGES;
// 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

const DAY_MS = 86_400_000;

/**
 * [Web Admin] 접속 통계 — DAU/WAU/MAU 와 일별 추이.
 *
 * device_activity 는 (디바이스, UTC 날짜) 롤업이라 활성 **디바이스**가 기본 단위다.
 * 활성 **유저**는 user_id distinct 로 따로 센다 — 익명 디바이스는 유저로 잡히지 않는다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rangeParam = new URL(req.url).searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "30d";
  const days = RANGES[range];

  const db = getDb();
  const sinceDay = sql`((now() at time zone 'UTC')::date - ${days - 1}::int)`;
  const inRange = and(eq(deviceActivity.projectId, id), gte(deviceActivity.day, sinceDay));

  /** 최근 n일 안의 고유 디바이스/유저 — DAU(1)/WAU(7)/MAU(30) 공용 */
  const activeWithin = (n: number) =>
    db
      .select({
        devices: sql<number>`count(distinct ${deviceActivity.deviceId})::int`,
        users: sql<number>`count(distinct ${deviceActivity.userId})::int`,
      })
      .from(deviceActivity)
      .where(
        and(
          eq(deviceActivity.projectId, id),
          gte(deviceActivity.day, sql`((now() at time zone 'UTC')::date - ${n - 1}::int)`)
        )
      );

  const [dau, wau, mau, series, platforms, totals] = await Promise.all([
    activeWithin(1),
    activeWithin(7),
    activeWithin(30),
    db
      .select({
        day: sql<string>`${deviceActivity.day}::text`,
        devices: sql<number>`count(distinct ${deviceActivity.deviceId})::int`,
        users: sql<number>`count(distinct ${deviceActivity.userId})::int`,
        opens: sql<number>`coalesce(sum(${deviceActivity.opens}), 0)::int`,
      })
      .from(deviceActivity)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ platform: deviceActivity.platform, count: sql<number>`count(distinct ${deviceActivity.deviceId})::int` })
      .from(deviceActivity)
      .where(inRange)
      .groupBy(deviceActivity.platform),
    db
      .select({ opens: sql<number>`coalesce(sum(${deviceActivity.opens}), 0)::int` })
      .from(deviceActivity)
      .where(inRange),
  ]);

  // 빈 날은 0 으로 채운다 — 없는 날을 건너뛰면 차트가 시간축을 왜곡한다
  const byDay = new Map(series.map((r) => [r.day, r]));
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const buckets: Array<{ day: string; devices: number; users: number; opens: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(d);
    buckets.push({ day: d, devices: row?.devices ?? 0, users: row?.users ?? 0, opens: row?.opens ?? 0 });
  }

  const stick = (mau[0]?.devices ?? 0) > 0 ? (dau[0]?.devices ?? 0) / (mau[0]!.devices) : null;

  return ok({
    range,
    dau: dau[0] ?? { devices: 0, users: 0 },
    wau: wau[0] ?? { devices: 0, users: 0 },
    mau: mau[0] ?? { devices: 0, users: 0 },
    // DAU/MAU — 분모가 0이면 비율은 정의되지 않는다(0% 로 위장하지 않는다)
    stickiness: stick,
    opens: totals[0]?.opens ?? 0,
    buckets,
    platforms: Object.fromEntries(platforms.map((p) => [p.platform ?? "unknown", p.count])),
  });
}
