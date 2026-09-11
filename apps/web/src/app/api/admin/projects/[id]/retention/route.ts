import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** 리텐션을 재는 시점(일차). D0 는 항상 100% 라 의미가 없어 뺀다. */
const OFFSETS = [1, 3, 7, 14, 30];
/**
 * 코호트로 볼 기간(일). 오늘부터 거슬러 이 만큼의 설치일을 코호트로 묶는다.
 *
 * 가장 오래된 코호트는 `오늘 - (COHORT_DAYS - 1)` 이므로, 최대 오프셋을 관측하려면
 * 그 코호트의 경과일이 최대 오프셋 이상이어야 한다. OFFSETS 에서 파생시키지 않으면
 * 둘이 어긋나 해당 시점이 영구히 null 로만 나온다(30 이었을 때 D30 이 그랬다).
 */
const COHORT_DAYS = Math.max(...OFFSETS) + 1;

/**
 * [Web Admin] 설치 코호트 리텐션.
 *
 * "설치일"은 device_activity 의 **최초 활동일**이다. devices.createdAt 을 쓰면
 * 등록만 하고 한 번도 안 연 기기가 코호트에 들어가 분모가 부풀려진다.
 *
 * 아직 D+n 이 지나지 않은 코호트는 비율을 내지 않는다(null). 0% 로 표시하면
 * "다 이탈했다"로 오독되는데 실제로는 아직 관측 기간이 오지 않은 것이다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();

  // 디바이스별 최초 활동일 → 코호트. 그 뒤 각 오프셋에서 재방문 여부를 센다.
  const rows = await db.execute(sql`
    with first_seen as (
      select device_id, min(day) as cohort_day
      from device_activity
      where project_id = ${id}
      group by device_id
    ),
    cohorts as (
      select cohort_day, count(*)::int as size
      from first_seen
      where cohort_day >= (now() at time zone 'UTC')::date - ${COHORT_DAYS - 1}::int
      group by cohort_day
    )
    select
      to_char(c.cohort_day, 'YYYY-MM-DD') as cohort_day,
      c.size,
      ${sql.join(
        OFFSETS.map(
          (n) => sql`count(distinct a.device_id) filter (
            where a.day = c.cohort_day + ${n}::int
          )::int as d${sql.raw(String(n))}`
        ),
        sql`, `
      )}
    from cohorts c
    join first_seen f on f.cohort_day = c.cohort_day
    left join device_activity a
      on a.device_id = f.device_id and a.project_id = ${id}
    group by c.cohort_day, c.size
    order by c.cohort_day desc
  `);

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const cohorts = (rows as unknown as Array<Record<string, string | number>>).map((r) => {
    const day = String(r.cohort_day);
    const size = Number(r.size);
    const cohortMs = Date.parse(`${day}T00:00:00Z`);
    const elapsedDays = Math.floor((todayUtc - cohortMs) / 86_400_000);

    return {
      day,
      size,
      points: OFFSETS.map((n) => {
        // 아직 D+n 이 오지 않았으면 관측 불가 — 0% 가 아니라 null
        if (elapsedDays < n) return { offset: n, retained: null, rate: null };
        const retained = Number(r[`d${n}`] ?? 0);
        return { offset: n, retained, rate: size > 0 ? retained / size : null };
      }),
    };
  });

  // 전체 평균 — 관측 가능한 코호트만 가중 평균한다
  const summary = OFFSETS.map((n) => {
    let retained = 0;
    let base = 0;
    for (const c of cohorts) {
      const p = c.points.find((x) => x.offset === n);
      if (p?.retained === null || p?.retained === undefined) continue;
      retained += p.retained;
      base += c.size;
    }
    return { offset: n, retained, base, rate: base > 0 ? retained / base : null };
  });

  return ok({ offsets: OFFSETS, cohorts, summary });
}
