import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const LIMIT = 50;

/**
 * [Web Admin] 유저 목록 — external_id / 속성 검색 + 디바이스·클릭 집계.
 *
 * 유저 중심 제품의 기본 조회 화면. 커서는 createdAt 키셋이라 새 유저가 들어와도
 * 페이지가 밀리지 않는다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? new Date(beforeParam) : null;
  if (before && Number.isNaN(before.getTime())) return fail("before must be an ISO timestamp", 422);

  const conds = [eq(pushUsers.projectId, id)];
  if (q) {
    // ilike 특수문자(%, _)를 리터럴로 — 검색어 하나로 전체 스캔이 되지 않게
    const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const like = `%${esc}%`;
    conds.push(or(ilike(pushUsers.externalId, like), ilike(pushUsers.phone, like))!);
  }
  if (before) conds.push(lt(pushUsers.createdAt, before));

  const db = getDb();
  const rows = await db
    .select({
      id: pushUsers.id,
      externalId: pushUsers.externalId,
      attributes: pushUsers.attributes,
      phone: pushUsers.phone,
      locale: pushUsers.locale,
      timezone: pushUsers.timezone,
      createdAt: pushUsers.createdAt,
      // 상관 서브쿼리는 별칭 + 원문 컬럼으로 쓴다. drizzle 의 컬럼 보간을 섞으면
      // 바깥 테이블과 이름이 겹쳐 ambiguous 로 터지거나 조용히 0 을 돌려준다.
      deviceCount: sql<number>`(
        select count(*)::int from devices d
        where d.user_id = push_users.id and d.is_active = true
      )`,
      clickCount: sql<number>`(
        select count(*)::int from push_clicks pc where pc.user_id = push_users.id
      )`,
      lastActiveAt: sql<string | null>`(
        select max(d.last_active_at) from devices d where d.user_id = push_users.id
      )`,
    })
    .from(pushUsers)
    .where(and(...conds))
    .orderBy(desc(pushUsers.createdAt))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const users = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({ users, next: hasMore ? users[users.length - 1]?.createdAt : null });
}
