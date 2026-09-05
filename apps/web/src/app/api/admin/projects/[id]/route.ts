import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  require_identity_verification: z.boolean().optional(),
  quiet_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  quiet_end_hour: z.number().int().min(0).max(23).nullable().optional(),
});

/** [Web Admin] 프로젝트 설정 변경 (방해금지 시간대, identity 검증 등) */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const set: Record<string, unknown> = {};
  if (b.require_identity_verification !== undefined) set.requireIdentityVerification = b.require_identity_verification;
  if (b.quiet_start_hour !== undefined) set.quietStartHour = b.quiet_start_hour;
  if (b.quiet_end_hour !== undefined) set.quietEndHour = b.quiet_end_hour;
  if (Object.keys(set).length === 0) return fail("no fields to update", 422);

  const db = getDb();
  const row = (
    await db.update(projects).set(set).where(eq(projects.id, id)).returning({
      id: projects.id,
      requireIdentityVerification: projects.requireIdentityVerification,
      quietStartHour: projects.quietStartHour,
      quietEndHour: projects.quietEndHour,
    })
  )[0];
  if (!row) return fail("Project not found", 404);
  return ok({ project: row });
}
