import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { geoImports } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth } from "@/lib/authz";

export const dynamic = "force-dynamic";

const LIMIT = 20;

/**
 * [Web Admin] 위치 데이터 적재 이력 + 현재 적재량.
 *
 * "국가가 왜 안 나오는가"를 추적하려면 두 가지가 함께 필요하다 — 마지막으로 언제
 * 무엇이 들어왔는지(이력), 그리고 지금 테이블에 실제로 몇 건이 있는지(현재값).
 * 이력만 보면 적재 후 누가 지운 경우를 놓친다.
 */
export async function GET(req: Request) {
  // 위치 데이터는 전역 참조 데이터라 테넌트 정보를 담지 않는다. superadmin 을
  // 요구하면 쿠키 세션은 그 값이 항상 false 라 브라우저에서 영영 못 본다
  // (superadmin 은 x-admin-token 으로만 켜진다). system/history 와 같은 기준을 쓴다.
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);

  const db = getDb();
  const [runs, current] = await Promise.all([
    db
      .select()
      .from(geoImports)
      .orderBy(desc(geoImports.startedAt))
      .limit(LIMIT),
    db.execute<{ countries: number; ipv4: number; ipv6: number }>(sql`
      select
        (select count(*)::int from countries) as countries,
        (select count(*)::int from ip_country_ranges where family = 4) as ipv4,
        (select count(*)::int from ip_country_ranges where family = 6) as ipv6
    `),
  ]);

  return ok({
    runs,
    current: current[0] ?? { countries: 0, ipv4: 0, ipv6: 0 },
    // 프록시 신뢰 설정이 없으면 데이터가 있어도 국가가 기록되지 않는다 —
    // 화면에서 그 상태를 알 수 있어야 한다.
    trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0,
  });
}
