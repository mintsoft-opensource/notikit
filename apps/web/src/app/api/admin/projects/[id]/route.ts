import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  require_identity_verification: z.boolean().optional(),
  quiet_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  quiet_end_hour: z.number().int().min(0).max(23).nullable().optional(),
  frequency_cap_per_day: z.number().int().min(1).max(100).nullable().optional(),
});

const policyFields = {
  id: projects.id,
  requireIdentityVerification: projects.requireIdentityVerification,
  quietStartHour: projects.quietStartHour,
  quietEndHour: projects.quietEndHour,
  frequencyCapPerDay: projects.frequencyCapPerDay,
};

/** [Web Admin] 프로젝트 발송 정책 조회 — 설정 화면이 저장된 값으로 시작하게 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const row = (await getDb().select(policyFields).from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (!row) return fail("Project not found", 404);
  return ok({ project: row });
}

/** [Web Admin] 프로젝트 설정 변경 (방해금지 시간대, identity 검증, 하루 빈도 상한 등) */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  const parsed = patchSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const set: Record<string, unknown> = {};
  if (b.require_identity_verification !== undefined) set.requireIdentityVerification = b.require_identity_verification;
  if (b.quiet_start_hour !== undefined) set.quietStartHour = b.quiet_start_hour;
  if (b.quiet_end_hour !== undefined) set.quietEndHour = b.quiet_end_hour;
  if (b.frequency_cap_per_day !== undefined) set.frequencyCapPerDay = b.frequency_cap_per_day;
  if (Object.keys(set).length === 0) return fail("no fields to update", 422);

  const db = getDb();
  const row = (
    await db.update(projects).set(set).where(eq(projects.id, id)).returning(policyFields)
  )[0];
  if (!row) return fail("Project not found", 404);
  return ok({ project: row });
}
