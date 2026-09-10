import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushClicks, pushLogs, pushUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const LIMIT = 50;

/**
 * [Web Admin] 이 발송을 **읽은(알림을 누른) 사람 목록**.
 *
 * "읽음"의 근거는 SDK 가 보고한 알림 탭이다. 실제로 화면에 표시됐는지(전달)는
 * FCM/APNs 가 알려주지 않으므로 여기서 셀 수 있는 것은 클릭뿐이다.
 * 같은 사람이 여러 기기에서 눌렀으면 기기마다 한 행이다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; logId: string }> }) {
  const { id, logId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? new Date(beforeParam) : null;
  if (before && Number.isNaN(before.getTime())) return fail("before must be an ISO timestamp", 422);

  const db = getDb();

  // 로그가 이 프로젝트 것인지 먼저 확인 — 타 테넌트의 수신자 명단이 새지 않게
  const log = (
    await db
      .select({ id: pushLogs.id, title: pushLogs.title, type: pushLogs.type, target: pushLogs.target,
                createdAt: pushLogs.createdAt,
                audienceUserCount: pushLogs.audienceUserCount, audienceDeviceCount: pushLogs.audienceDeviceCount,
                clickCount: pushLogs.clickCount, clickUserCount: pushLogs.clickUserCount })
      .from(pushLogs)
      .where(and(eq(pushLogs.id, logId), eq(pushLogs.projectId, id)))
      .limit(1)
  )[0];
  if (!log) return fail("Message not found", 404);

  const conds = [eq(pushClicks.logId, logId), eq(pushClicks.projectId, id)];
  if (before) conds.push(lt(pushClicks.clickedAt, before));

  const rows = await db
    .select({
      id: pushClicks.id,
      externalId: pushUsers.externalId,
      platform: pushClicks.platform,
      destination: pushClicks.destination,
      clickedAt: pushClicks.clickedAt,
    })
    .from(pushClicks)
    .leftJoin(pushUsers, eq(pushClicks.userId, pushUsers.id))
    .where(and(...conds))
    .orderBy(desc(pushClicks.clickedAt))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const readers = hasMore ? rows.slice(0, LIMIT) : rows;

  // 읽은 수 추이 — 발송 시각부터 마지막 클릭까지. 하루를 넘기면 일 단위로 접는다
  // (시간 버킷으로 몇 주를 그리면 축이 읽히지 않는다).
  const [span] = await db
    .select({ last: sql<string | null>`max(${pushClicks.clickedAt})` })
    .from(pushClicks)
    .where(and(eq(pushClicks.logId, logId), eq(pushClicks.projectId, id)));

  const startMs = new Date(log.createdAt).getTime();
  const lastMs = span?.last ? new Date(span.last).getTime() : startMs;
  const HOUR = 3_600_000;
  const byDay = lastMs - startMs > 48 * HOUR;
  const bucketMs = byDay ? 24 * HOUR : HOUR;
  const trunc = byDay ? "day" : "hour";

  const bucketRows = await db
    .select({
      // DB 세션 TZ 와 무관하게 UTC 경계로 자른다 — 아래 빈 버킷 채우기와 키가 맞아야 한다
      bucket: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${pushClicks.clickedAt} at time zone 'UTC') at time zone 'UTC'`,
      count: sql<number>`count(*)::int`,
    })
    .from(pushClicks)
    .where(and(eq(pushClicks.logId, logId), eq(pushClicks.projectId, id)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byBucket = new Map(bucketRows.map((r) => [new Date(r.bucket).toISOString(), r.count]));
  const start = new Date(startMs);
  if (byDay) start.setUTCHours(0, 0, 0, 0);
  else start.setUTCMinutes(0, 0, 0);

  const series: Array<{ ts: string; count: number; cumulative: number }> = [];
  let running = 0;
  for (let t = start.getTime(); t <= lastMs; t += bucketMs) {
    const ts = new Date(t).toISOString();
    const count = byBucket.get(ts) ?? 0;
    running += count;
    series.push({ ts, count, cumulative: running });
    if (series.length >= 400) break; // 축이 감당 못 하는 길이는 끊는다
  }

  return ok({
    log,
    readers,
    series,
    bucket: trunc,
    next: hasMore ? readers[readers.length - 1]?.clickedAt : null,
  });
}
