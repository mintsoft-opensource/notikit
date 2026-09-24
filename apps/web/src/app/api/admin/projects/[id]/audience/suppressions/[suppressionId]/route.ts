import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { buildDiff, failAudited, recordAudit } from "@/lib/audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * 수신거부 단건 — 상세 화면용.
 *
 * 모든 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 수신거부를
 * id 추측만으로 읽거나 해제할 수 있다 — 해제는 곧 그 사람에게 다시 발송된다는 뜻이다.
 *
 * 대상(external_id/token)은 바꿀 수 없고 사유만 고칠 수 있다. 대상을 바꾸는 것은
 * "이 사람 차단을 풀고 저 사람을 차단"이라 삭제 후 재등록이어야 의도가 드러난다.
 */
const updateSchema = z.object({
  reason: z.enum(["opt_out", "bounced", "complaint", "manual"]),
});

/**
 * 내보낼 컬럼. **`token` 원문은 절대 포함하지 않는다.**
 *
 * 목록 API 가 같은 이유로 마스킹한다 — 푸시 토큰은 그 기기로 발송할 수 있는 값이라
 * 화면에 띄울 이유가 없다. `select()` 로 전체 행을 돌려주면 그 방어가 조용히 풀린다.
 */
const columns = {
  id: suppressions.id,
  projectId: suppressions.projectId,
  externalId: suppressions.externalId,
  tokenPreview: sql<string | null>`case when ${suppressions.token} is null then null
    when length(${suppressions.token}) <= 16 then '…' || right(${suppressions.token}, 4)
    else left(${suppressions.token}, 8) || '…' || right(${suppressions.token}, 4) end`,
  reason: suppressions.reason,
  createdAt: suppressions.createdAt,
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string; suppressionId: string }> }) {
  const { id, suppressionId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const row = (
    await db
      .select(columns)
      .from(suppressions)
      .where(and(eq(suppressions.id, suppressionId), eq(suppressions.projectId, id)))
      .limit(1)
  )[0];
  if (!row) return fail("Not found", 404);
  return ok({ suppression: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; suppressionId: string }> }) {
  const { id, suppressionId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "suppression.update", "suppression", authz, suppressionId);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  // 바뀌기 전 사유. update 의 returning 만 보면 "무엇에서 무엇으로" 를 알 수 없다.
  const previous = (
    await db
      .select({ reason: suppressions.reason })
      .from(suppressions)
      .where(and(eq(suppressions.id, suppressionId), eq(suppressions.projectId, id)))
      .limit(1)
  )[0];
  const rows = await db
    .update(suppressions)
    .set({ reason: parsed.data.reason })
    .where(and(eq(suppressions.id, suppressionId), eq(suppressions.projectId, id)))
    // returning() 도 전체 행이다 — 여기서도 토큰을 빼야 한다
    .returning(columns);
  if (rows.length === 0) return fail("Not found", 404);
  const diff = buildDiff(previous, { reason: rows[0].reason });
  if (diff) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      action: "suppression.update",
      targetType: "suppression",
      targetId: suppressionId,
      diff,
    });
  }
  return ok({ suppression: rows[0] });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; suppressionId: string }> }) {
  const { id, suppressionId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "suppression.delete", "suppression", authz, suppressionId);

  const db = getDb();
  const rows = await db
    .delete(suppressions)
    .where(and(eq(suppressions.id, suppressionId), eq(suppressions.projectId, id)))
    .returning({ id: suppressions.id, externalId: suppressions.externalId, reason: suppressions.reason });
  if (rows.length === 0) return fail("Not found", 404);
  await recordAudit({
    projectId: id,
    actor: authz.ctx,
    action: "suppression.delete",
    targetType: "suppression",
    targetId: rows[0].id,
    diff: buildDiff({ externalId: rows[0].externalId, reason: rows[0].reason }, null),
  });
  return ok({ deleted: rows[0].id });
}
