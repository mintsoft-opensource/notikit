import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { buildDiff, failAudited, recordAudit } from "@/lib/audit";
import { createSchedule, listSchedules, scheduleInputSchema } from "@/lib/schedules";

export const dynamic = "force-dynamic";

/** [Web Admin] 반복 예약 목록 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  return ok({ schedules: await listSchedules(id) });
}

/** [Web Admin] 반복 예약 생성 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "schedule.create", "schedule", authz);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = scheduleInputSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const schedule = await createSchedule(id, parsed.data);
  if (!schedule) return fail("Not found", 404);
  await recordAudit({
    projectId: id,
    actor: authz.ctx,
    action: "schedule.create",
    targetType: "schedule",
    targetId: schedule.id,
    diff: buildDiff(null, { ...schedule }),
  });
  return ok({ schedule }, undefined, 201);
}
