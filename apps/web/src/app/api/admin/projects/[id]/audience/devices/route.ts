import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const LIMIT = 50;
const PLATFORMS = ["android", "ios", "web", "webview", "electron", "flutter", "react-native"] as const;
type Platform = (typeof PLATFORMS)[number];

/**
 * [Web Admin] 디바이스 목록 — 플랫폼/활성 필터 + 요약 집계.
 *
 * 토큰 원문은 내보내지 않는다. 남의 토큰을 알면 클릭 위조·바인딩 해제에 쓸 수 있어
 * 관리 화면이라도 굳이 노출할 이유가 없다 — 식별용 앞뒤 일부만 보여준다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform");
  const platform = PLATFORMS.includes(platformParam as Platform) ? (platformParam as Platform) : null;
  const activeParam = url.searchParams.get("active");
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? new Date(beforeParam) : null;
  if (before && Number.isNaN(before.getTime())) return fail("before must be an ISO timestamp", 422);

  const conds = [eq(devices.projectId, id)];
  if (platform) conds.push(eq(devices.platform, platform));
  if (activeParam === "true") conds.push(eq(devices.isActive, true));
  if (activeParam === "false") conds.push(eq(devices.isActive, false));
  if (before) conds.push(lt(devices.createdAt, before));

  const db = getDb();
  const [rows, summary] = await Promise.all([
    db
      .select({
        id: devices.id,
        // 앞 8 / 뒤 4 만 — 식별에는 충분하고 재사용에는 쓸 수 없다
        tokenPreview: sql<string>`left(${devices.token}, 8) || '…' || right(${devices.token}, 4)`,
        platform: devices.platform,
        isActive: devices.isActive,
        appVersion: devices.appVersion,
        osVersion: devices.osVersion,
        locale: devices.locale,
        country: devices.country,
        lastActiveAt: devices.lastActiveAt,
        createdAt: devices.createdAt,
        externalId: pushUsers.externalId,
      })
      .from(devices)
      .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
      .where(and(...conds))
      .orderBy(desc(devices.createdAt))
      .limit(LIMIT + 1),
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${devices.isActive})::int`,
        // 유저에 바인딩되지 않은 기기 — 유저 타겟 발송과 유저 단위 통계에서 빠진다
        anonymous: sql<number>`count(*) filter (where ${devices.userId} is null)::int`,
      })
      .from(devices)
      .where(eq(devices.projectId, id)),
  ]);

  const hasMore = rows.length > LIMIT;
  const list = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({
    devices: list,
    summary: summary[0] ?? { total: 0, active: 0, anonymous: 0 },
    next: hasMore ? list[list.length - 1]?.createdAt : null,
  });
}
