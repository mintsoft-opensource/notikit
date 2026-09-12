import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { segments } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * 세그먼트 단건 — 상세/수정 화면용.
 *
 * 모든 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 세그먼트를
 * id 추측만으로 읽거나 고칠 수 있다.
 */
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  rules: z
    .array(z.object({ attribute: z.string().min(1).max(64), value: z.string().max(255) }))
    .max(20)
    .optional(),
});

async function load(projectId: string, segmentId: string) {
  const db = getDb();
  return (
    await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, segmentId), eq(segments.projectId, projectId)))
      .limit(1)
  )[0];
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const row = await load(id, segmentId);
  if (!row) return fail("Not found", 404);
  return ok({ segment: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  // 빈 PATCH 는 수정이 아니라 호출 실수다. 조용히 200 을 주면 저장된 줄 안다.
  if (parsed.data.name === undefined && parsed.data.rules === undefined) {
    return fail("변경할 내용이 없습니다", 422);
  }

  const db = getDb();
  const rows = await db
    .update(segments)
    .set(parsed.data)
    .where(and(eq(segments.id, segmentId), eq(segments.projectId, id)))
    .returning();
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ segment: rows[0] });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const rows = await db
    .delete(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.projectId, id)))
    .returning({ id: segments.id });
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ deleted: rows[0].id });
}
