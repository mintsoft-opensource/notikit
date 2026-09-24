import { and, desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { auditLogs, auditConds, parseAuditFilters } from "@/lib/audit";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";

export const dynamic = "force-dynamic";

const LIMIT = 50;

/**
 * [Web Admin] 감사 로그 — 최신순, 읽기 전용.
 *
 * 쓰기 엔드포인트가 없다. 감사 로그를 화면에서 고치거나 지울 수 있으면 감사가 아니다
 * (보관 기간 정리는 리텐션 작업이 할 일이지 콘솔의 버튼이 아니다).
 *
 * 필터: `?action=`(기본 action — 거부된 시도도 함께), `?actor=`(uuid 또는 라벨),
 * `?from=`·`?to=`(+`?tz_offset=`). 커서는 다른 콘솔과 같은 `(created_at, id)` 복합 커서다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const conds = auditConds(id, parseAuditFilters(url));
  const cursor = parseCursor(url);
  if (cursor) conds.push(beforeCursor(auditLogs.createdAt, auditLogs.id, cursor));

  const rows = await getDb()
    .select({
      id: auditLogs.id,
      actorId: auditLogs.actorUserId,
      actorLabel: auditLogs.actor,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      diff: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      cursorTs: cursorExpr(auditLogs.createdAt),
    })
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const list = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({
    entries: list.map(({ cursorTs: _cursorTs, ...r }) => r),
    next: nextCursor(list, hasMore),
  });
}
