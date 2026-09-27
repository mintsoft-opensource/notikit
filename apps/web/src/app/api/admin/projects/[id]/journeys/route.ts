import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { journeyStepsSchema, toStoredSteps, triggerEventsOf } from "@/lib/journey-triggers";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const db = getDb();
  const rows = await db.select().from(journeys).where(eq(journeys.projectId, id)).orderBy(desc(journeys.createdAt));
  return ok({ journeys: rows });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // 스텝 검증은 한 곳(journeyStepsSchema)에서만 — 생성과 수정이 따로 들고 있으면
  // 한쪽에만 규칙이 붙어 "만들 수는 있는데 고치면 422" 가 된다
  steps: journeyStepsSchema,
});

/** [Web Admin] 저니 생성 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const row = (await db.insert(journeys).values({ projectId: id, name: parsed.data.name, steps: toStoredSteps(parsed.data.steps), triggerEvents: triggerEventsOf(parsed.data.steps) }).returning())[0];
  return ok({ journey: row }, undefined, 201);
}
