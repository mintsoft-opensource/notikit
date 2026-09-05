import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { segments } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** [Web Admin] 세그먼트 목록 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const db = getDb();
  const rows = await db.select().from(segments).where(eq(segments.projectId, id)).orderBy(desc(segments.createdAt));
  return ok({ segments: rows });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  rules: z.array(z.object({ attribute: z.string().min(1).max(64), value: z.string().max(255) })).max(20).default([]),
});

/** [Web Admin] 세그먼트 생성 (속성 규칙 AND) */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const row = (
    await db.insert(segments).values({ projectId: id, name: parsed.data.name, rules: parsed.data.rules }).returning()
  )[0];
  return ok({ segment: row }, undefined, 201);
}
