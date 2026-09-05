import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 프로젝트 푸시 로그 (최근 50) */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
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
      variantStats: pushLogs.variantStats,
      createdAt: pushLogs.createdAt,
    })
    .from(pushLogs)
    .where(eq(pushLogs.projectId, id))
    .orderBy(desc(pushLogs.createdAt))
    .limit(50);
  return ok({ logs: rows });
}
