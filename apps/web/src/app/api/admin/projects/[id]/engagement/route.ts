import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushClicks, pushLogs } from "@/db/schema";
import { logSentAtSql } from "@/lib/log-sent-at";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type RangeKey = keyof typeof RANGES;
// 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** 읽기까지 걸린 시간 구간 (초). 상한이 null 이면 그 이상 전부. */
const LATENCY_BUCKETS: Array<{ key: string; upto: number | null }> = [
  { key: "lt1m", upto: 60 },
  { key: "lt5m", upto: 300 },
  { key: "lt30m", upto: 1800 },
  { key: "lt2h", upto: 7200 },
  { key: "lt1d", upto: 86400 },
  { key: "gte1d", upto: null },
];

/**
 * [Web Admin] 참여 심화 통계.
 *
 * 세 가지 모두 push_clicks 에서 나온다:
 * - 요일×시간 히트맵: 언제 보내야 열리는지
 * - 읽기까지 걸린 시간: 푸시가 즉시 소비되는지, 나중에 발견되는지
 * - 플랫폼 분포: iOS/Android 중 어디서 반응이 오는지
 *
 * 시간은 전부 UTC 기준이다. 서버 로컬시각을 쓰면 배포 지역에 따라 같은 데이터가
 * 다른 시간대로 읽힌다. 실제 유저 현지시각과는 다르므로 화면에 UTC 임을 명시한다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rangeParam = new URL(req.url).searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "30d";
  const since = new Date(Date.now() - RANGES[range] * 86_400_000);

  const db = getDb();
  const inRange = and(eq(pushClicks.projectId, id), gte(pushClicks.clickedAt, since));

  const [heatRows, latencyRows, platformRows, totalRow] = await Promise.all([
    db
      .select({
        dow: sql<number>`extract(dow from ${pushClicks.clickedAt} at time zone 'UTC')::int`,
        hour: sql<number>`extract(hour from ${pushClicks.clickedAt} at time zone 'UTC')::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(pushClicks)
      .where(inRange)
      .groupBy(sql`1, 2`),
    // 발송 시각과의 차이 — 로그를 조인해야 하므로 클릭만으로는 못 낸다
    db
      .select({
        seconds: sql<number>`extract(epoch from (${pushClicks.clickedAt} - ${logSentAtSql()}))::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(pushClicks)
      .innerJoin(pushLogs, eq(pushClicks.logId, pushLogs.id))
      .where(inRange)
      .groupBy(sql`1`),
    db
      .select({ platform: pushClicks.platform, count: sql<number>`count(*)::int` })
      .from(pushClicks)
      .where(inRange)
      .groupBy(pushClicks.platform)
      .orderBy(sql`count(*) desc`),
    db.select({ count: sql<number>`count(*)::int` }).from(pushClicks).where(inRange),
  ]);

  // 7×24 격자를 0으로 채운 뒤 실제 값을 얹는다 — 빈 칸을 생략하면 격자가 어긋난다
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let peak = { dow: 0, hour: 0, count: 0 };
  for (const r of heatRows) {
    if (r.dow < 0 || r.dow > 6 || r.hour < 0 || r.hour > 23) continue;
    heatmap[r.dow][r.hour] = r.count;
    if (r.count > peak.count) peak = { dow: r.dow, hour: r.hour, count: r.count };
  }

  // 초 단위 결과를 구간으로 접는다. 음수(발송 시각보다 이른 클릭)는 시계 오차이므로 첫 구간에 넣는다.
  const latency = Object.fromEntries(LATENCY_BUCKETS.map((b) => [b.key, 0])) as Record<string, number>;
  let latencyTotal = 0;
  let latencySum = 0;
  for (const r of latencyRows) {
    const s = Math.max(0, r.seconds ?? 0);
    const bucket = LATENCY_BUCKETS.find((b) => b.upto === null || s < b.upto)!;
    latency[bucket.key] += r.count;
    latencyTotal += r.count;
    latencySum += s * r.count;
  }

  return ok({
    range,
    total: totalRow[0]?.count ?? 0,
    heatmap,
    // 클릭이 하나도 없으면 "피크"라는 개념이 없다 — 0시로 위장하지 않는다
    peak: peak.count > 0 ? peak : null,
    latency,
    // 평균은 꼬리에 끌려간다 — 중앙값이 없는 대신 구간 분포를 함께 보게 한다
    latencyAvgSeconds: latencyTotal > 0 ? Math.round(latencySum / latencyTotal) : null,
    platforms: platformRows.map((p) => ({ platform: p.platform ?? "unknown", count: p.count })),
  });
}
