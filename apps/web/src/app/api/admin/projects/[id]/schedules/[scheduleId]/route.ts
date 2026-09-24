import { z } from "zod";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { buildDiff, failAudited, recordAudit } from "@/lib/audit";
import { deleteSchedule, getSchedule, scheduleInputSchema, setScheduleEnabled, updateSchedule } from "@/lib/schedules";

export const dynamic = "force-dynamic";

/**
 * 반복 예약 단건. 모든 조회·수정에 `projectId` 를 함께 건다 —
 * id 만으로 찾으면 다른 프로젝트의 예약을 id 추측만으로 읽거나 끌 수 있다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; scheduleId: string }> }) {
  const { id, scheduleId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const schedule = await getSchedule(id, scheduleId);
  if (!schedule) return fail("Not found", 404);
  return ok({ schedule });
}

/**
 * 켜기/끄기만 하는 요청과 전체 교체를 함께 받는다. 목록의 토글이 본문 전체를 되돌려
 * 보내게 만들면, 그 사이 다른 창에서 고친 내용을 토글 한 번이 덮어쓴다.
 */
const toggleSchema = z.object({ enabled: z.boolean() }).strict();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; scheduleId: string }> }) {
  const { id, scheduleId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "schedule.update", "schedule", authz, scheduleId);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }

  const toggle = toggleSchema.safeParse(payload);
  if (toggle.success) {
    // 켜고 끈 기록이 가장 자주 찾게 되는 항목이다("이 예약 누가 껐나")
    const before = await getSchedule(id, scheduleId);
    const schedule = await setScheduleEnabled(id, scheduleId, toggle.data.enabled);
    if (!schedule) return fail("Not found", 404);
    const diff = buildDiff({ enabled: before?.enabled }, { enabled: schedule.enabled });
    if (diff) {
      await recordAudit({
        projectId: id,
        actor: authz.ctx,
        action: "schedule.update",
        targetType: "schedule",
        targetId: scheduleId,
        diff,
      });
    }
    return ok({ schedule });
  }

  const parsed = scheduleInputSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const existing = await getSchedule(id, scheduleId);
  if (!existing) return fail("Not found", 404);
  const schedule = await updateSchedule(id, scheduleId, parsed.data);
  if (!schedule) return fail("Not found", 404);
  const diff = buildDiff({ ...existing }, { ...schedule });
  if (diff) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      action: "schedule.update",
      targetType: "schedule",
      targetId: scheduleId,
      diff,
    });
  }
  return ok({ schedule });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; scheduleId: string }> }) {
  const { id, scheduleId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "schedule.delete", "schedule", authz, scheduleId);
  // 지우기 전 내용을 읽어 둔다 — 지운 뒤엔 무엇이 사라졌는지 물어볼 데가 없다
  const existing = await getSchedule(id, scheduleId);
  const deleted = await deleteSchedule(id, scheduleId);
  if (!deleted) return fail("Not found", 404);
  await recordAudit({
    projectId: id,
    actor: authz.ctx,
    action: "schedule.delete",
    targetType: "schedule",
    targetId: scheduleId,
    diff: buildDiff(existing ? { ...existing } : { id: scheduleId }, null),
  });
  return ok({ deleted });
}
