import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAdmin } from "@/lib/keys";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const { id } = await ctx.params;
  const db = getDb();
  const rows = await db.select().from(journeys).where(eq(journeys.projectId, id)).orderBy(desc(journeys.createdAt));
  return ok({ journeys: rows });
}

const stepSchema = z.object({
  type: z.enum(["send", "wait"]),
  title: z.string().max(255).optional(),
  body: z.string().max(4000).optional(),
  hours: z.number().int().min(0).max(24 * 365).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(stepSchema).min(1).max(30),
});

/** [Web Admin] 저니 생성 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const { id } = await ctx.params;
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const row = (await db.insert(journeys).values({ projectId: id, name: parsed.data.name, steps: parsed.data.steps }).returning())[0];
  return ok({ journey: row }, undefined, 201);
}
