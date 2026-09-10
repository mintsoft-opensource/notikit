import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

const REASONS = ["opt_out", "bounced", "complaint", "manual"] as const;

/**
 * [Web Admin] 억제 목록 — 절대 발송하지 않을 대상.
 * 발송 경로가 이 목록으로 토큰을 걸러내고, 클릭률 분모에서도 빠진다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const rows = await db
    .select()
    .from(suppressions)
    .where(eq(suppressions.projectId, id))
    .orderBy(desc(suppressions.createdAt))
    .limit(200);
  return ok({ suppressions: rows });
}

const createSchema = z
  .object({
    external_id: z.string().max(255).optional(),
    token: z.string().max(4096).optional(),
    reason: z.enum(REASONS).default("manual"),
  })
  .refine((d) => d.external_id || d.token, "external_id or token is required");

/** [Web Admin] 억제 추가 */
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
  const b = parsed.data;

  const db = getDb();
  const row = (
    await db
      .insert(suppressions)
      .values({ projectId: id, externalId: b.external_id ?? null, token: b.token ?? null, reason: b.reason })
      .returning()
  )[0];
  return ok({ suppression: row }, undefined, 201);
}

/** [Web Admin] 억제 해제 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const sid = new URL(req.url).searchParams.get("id");
  if (!sid) return fail("id is required", 422);

  const db = getDb();
  // projectId 를 함께 건다 — id 만으로 지우면 타 테넌트의 억제를 풀 수 있다
  const deleted = await db
    .delete(suppressions)
    .where(and(eq(suppressions.projectId, id), eq(suppressions.id, sid)))
    .returning({ id: suppressions.id });
  if (deleted.length === 0) return fail("Suppression not found", 404);
  return ok({ deleted: deleted.length });
}
