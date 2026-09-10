import { and, desc, eq } from "drizzle-orm";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

const TYPES = ["single", "topic", "broadcast", "segment"] as const;
type LogType = (typeof TYPES)[number];
const LIMIT = 50;

/** [Web Admin] 프로젝트 푸시 로그. type 으로 단건/토픽 등을 나눠 볼 수 있다. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type");
  // 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
  const type = TYPES.includes(typeParam as LogType) ? (typeParam as LogType) : null;
  const cursor = parseCursor(url);

  const conds = [eq(pushLogs.projectId, id)];
  if (type) conds.push(eq(pushLogs.type, type));
  if (cursor) conds.push(beforeCursor(pushLogs.createdAt, pushLogs.id, cursor));

  const db = getDb();
  // 요약 필드만 (수신자/본문/데이터/딥링크 등 민감정보 노출 방지)
  const rows = await db
    .select({
      id: pushLogs.id,
      title: pushLogs.title,
      type: pushLogs.type,
      status: pushLogs.status,
      totalCount: pushLogs.totalCount,
      successCount: pushLogs.successCount,
      failureCount: pushLogs.failureCount,
      // 토픽/세그먼트 이름, 단건의 external_id
      target: pushLogs.target,
      // 클릭률 = clickUserCount / audienceUserCount (분모는 발송 시점 스냅샷)
      audienceUserCount: pushLogs.audienceUserCount,
      audienceDeviceCount: pushLogs.audienceDeviceCount,
      clickCount: pushLogs.clickCount,
      clickUserCount: pushLogs.clickUserCount,
      variantStats: pushLogs.variantStats,
      createdAt: pushLogs.createdAt,
      cursorTs: cursorExpr(pushLogs.createdAt),
    })
    .from(pushLogs)
    .where(and(...conds))
    .orderBy(desc(pushLogs.createdAt), desc(pushLogs.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const logs = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({ logs: logs.map(({ cursorTs: _cursorTs, ...l }) => l), next: nextCursor(logs, hasMore) });
}
