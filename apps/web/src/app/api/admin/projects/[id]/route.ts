import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { buildDiff, failAudited, recordAudit } from "@/lib/audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  require_identity_verification: z.boolean().optional(),
  quiet_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  quiet_end_hour: z.number().int().min(0).max(23).nullable().optional(),
  frequency_cap_per_day: z.number().int().min(1).max(100).nullable().optional(),
  /** 분당 발송 상한(기기 수). null 이면 제한 없음 — 소진하면 다음 분까지 미뤘다 이어 보낸다. */
  max_sends_per_minute: z.number().int().min(1).max(100_000).nullable().optional(),
});

const policyFields = {
  id: projects.id,
  requireIdentityVerification: projects.requireIdentityVerification,
  quietStartHour: projects.quietStartHour,
  quietEndHour: projects.quietEndHour,
  frequencyCapPerDay: projects.frequencyCapPerDay,
  maxSendsPerMinute: projects.maxSendsPerMinute,
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
  if (!authz.ok) return failAudited(req, id, "project.settings.update", "project", authz, id);
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
  if (b.max_sends_per_minute !== undefined) set.maxSendsPerMinute = b.max_sends_per_minute;
  if (Object.keys(set).length === 0) return fail("no fields to update", 422);

  const db = getDb();
  // 변경 **전** 값을 먼저 읽는다. update 의 returning 만으로는 "무엇이었는지" 를 영영 알 수 없고,
  // 감사 로그가 답해야 하는 질문은 대개 "이걸 누가 켰고 원래 뭐였나" 다.
  const previous = (await db.select(policyFields).from(projects).where(eq(projects.id, id)).limit(1))[0];
  const row = (
    await db.update(projects).set(set).where(eq(projects.id, id)).returning(policyFields)
  )[0];
  if (!row) return fail("Project not found", 404);

  const diff = buildDiff(previous, row);
  // 같은 값으로 다시 저장한 요청은 적지 않는다 — 잡음이 쌓이면 진짜 변경을 못 찾는다
  if (diff) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      action: "project.settings.update",
      targetType: "project",
      targetId: id,
      diff,
    });
  }
  return ok({ project: row });
}
