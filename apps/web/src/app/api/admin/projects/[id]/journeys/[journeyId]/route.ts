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
 *
 * **이름은 바꿀 수 없다.** SDK 의 enroll 은 저니를 이름으로 찾는다
 * (`/api/v1/journeys/enroll` → `eq(journeys.name, ...)`). 콘솔에서 개명하면 이미
 * 배포된 앱의 `enroll({journey:"welcome"})` 이 조용히 404 가 된다 — 토픽 이름을
 * 막은 것과 같은 이유다. 이름을 바꾸려면 새로 만들고 앱을 함께 배포해야 한다.
 */
const stepSchema = z.object({
  type: z.enum(["send", "wait"]),
  title: z.string().max(255).optional(),
  body: z.string().max(4000).optional(),
  hours: z.number().int().min(0).max(24 * 365).optional(),
});

const updateSchema = z.object({
  steps: z.array(stepSchema).min(1).max(30),
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
  /**
   * 실패를 0 으로 삼키지 않는다 — 이 값의 유일한 쓰임이 삭제 경고라서, 0 으로 보이면
   * "진행 중 실행 없음"으로 읽히고 경고 없이 실행 이력이 cascade 삭제된다.
   */
  const runs = await db.execute(
    raw`select count(*) filter (where status = 'active')::int as active,
               count(*)::int as total
          from journey_runs where journey_id = ${journeyId}`
  );
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
  const db = getDb();
  const rows = await db
    .update(journeys)
    .set({ steps: parsed.data.steps })
    .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
    .returning();
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ journey: rows[0] });
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
