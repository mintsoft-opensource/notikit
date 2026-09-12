import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * 발송 로그 단건 — 상세 화면용.
 *
 * 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 발송 내용을
 * id 추측만으로 읽을 수 있다 — 제목·본문·대상이 그대로 들어 있다.
 *
 * 컬럼을 **명시해서** 고른다. `select()` 로 전체 행을 주면 `lock_token`(워커 펜싱용
 * 내부 값)까지 함께 나간다. 화면에 쓸 이유가 없는 값은 내보내지 않는다.
 */
const columns = {
  id: pushLogs.id,
  type: pushLogs.type,
  target: pushLogs.target,
  title: pushLogs.title,
  body: pushLogs.body,
  data: pushLogs.data,
  deepLink: pushLogs.deepLink,
  status: pushLogs.status,
  totalCount: pushLogs.totalCount,
  successCount: pushLogs.successCount,
  failureCount: pushLogs.failureCount,
  readCount: pushLogs.readCount,
  scheduledAt: pushLogs.scheduledAt,
  variants: pushLogs.variants,
  variantStats: pushLogs.variantStats,
  kakaoFallback: pushLogs.kakaoFallback,
  kakaoCount: pushLogs.kakaoCount,
  audienceUserCount: pushLogs.audienceUserCount,
  audienceDeviceCount: pushLogs.audienceDeviceCount,
  clickCount: pushLogs.clickCount,
  clickUserCount: pushLogs.clickUserCount,
  createdAt: pushLogs.createdAt,
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string; logId: string }> }) {
  const { id, logId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const row = (
    await db
      .select(columns)
      .from(pushLogs)
      .where(and(eq(pushLogs.id, logId), eq(pushLogs.projectId, id)))
      .limit(1)
  )[0];
  if (!row) return fail("Not found", 404);

  return ok({ log: row });
}
