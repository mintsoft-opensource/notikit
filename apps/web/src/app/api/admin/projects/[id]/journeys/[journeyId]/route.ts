import { and, eq, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * 저니 단건 — 상세/수정 화면용.
 *
 * 모든 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 저니를
 * id 추측만으로 읽거나 고칠 수 있다.
 */
const stepSchema = z.object({
  type: z.enum(["send", "wait"]),
  title: z.string().max(255).optional(),
  body: z.string().max(4000).optional(),
  hours: z.number().int().min(0).max(24 * 365).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  steps: z.array(stepSchema).min(1).max(30).optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const row = (
    await db
      .select()
      .from(journeys)
      .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
      .limit(1)
  )[0];
  if (!row) return fail("Not found", 404);

  // 진행 중인 실행 수 — 스텝을 고치면 이 사람들에게 영향이 간다. 화면에서 경고하려면 필요하다.
  const runs = await db
    .execute(
      raw`select count(*) filter (where status = 'active')::int as active,
                 count(*)::int as total
            from journey_runs where journey_id = ${journeyId}`
    )
    .catch(() => [{ active: 0, total: 0 }]);
  const c = (runs as unknown as { active: number; total: number }[])[0] ?? { active: 0, total: 0 };

  // total 도 함께 준다 — 삭제는 완료된 실행 이력까지 cascade 로 지운다
  return ok({ journey: row, activeRuns: c.active, totalRuns: c.total });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
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
  if (parsed.data.name === undefined && parsed.data.steps === undefined) {
    return fail("변경할 내용이 없습니다", 422);
  }

  const db = getDb();
  try {
    const rows = await db
      .update(journeys)
      .set(parsed.data)
      .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
      .returning();
    if (rows.length === 0) return fail("Not found", 404);
    return ok({ journey: rows[0] });
  } catch (e) {
    // (project_id, name) 이 유니크다 — 중복을 500 으로 흘리면 원인을 알 수 없다
    if (e instanceof Error && /unique|duplicate/i.test(e.message)) {
      return fail("같은 이름의 저니가 이미 있습니다", 409);
    }
    throw e;
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  // journey_runs 는 FK cascade 로 함께 지워진다 — 진행 중이던 유저의 실행도 끝난다.
  const rows = await db
    .delete(journeys)
    .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
    .returning({ id: journeys.id });
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ deleted: rows[0].id });
}
