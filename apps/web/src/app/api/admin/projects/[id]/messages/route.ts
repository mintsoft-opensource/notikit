import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers, projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin, type AuthContext } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimitShared } from "@/lib/rate-limit";
import { messageSchema, enqueuePush, prepareMessage, MESSAGE_BODY_LIMIT, parseIdempotencyKey, findIdempotent } from "@/lib/messages";
import { buildDiff, recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** 발송자 기록 — 세션이면 멤버 이메일, 서버-투-서버(x-admin-token)면 "admin-token" */
async function senderOf(ctx: AuthContext): Promise<string> {
  if (ctx.superadmin || !ctx.userId) return "admin-token";
  const row = (
    await getDb().select({ email: adminUsers.email }).from(adminUsers).where(eq(adminUsers.id, ctx.userId)).limit(1)
  )[0];
  return row?.email ?? "unknown";
}

/**
 * [Web Admin] 콘솔에서 푸시 발송 — admin 세션/역할로 인가(api-secret 불필요).
 * 프로젝트 org 스코프 + write 역할 필요. 실제 fan-out 은 worker/process-queue.
 * `Idempotency-Key` 헤더로 더블클릭·재시도 중복 발송을 막는다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const { id } = await ctx.params;
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  // SDK(v1)와 동일한 스로틀 — 키는 분리해 콘솔 발송이 SDK 쿼터를 잠식하지 않게 함
  if (!await rateLimitShared(`admin:proj:${id}`)) return fail("Rate limit exceeded", 429);

  const project = (
    await getDb()
      // 방해금지는 프로젝트 시간대로 판정한다 — 빠지면 UTC 로 계산돼 KST 프로젝트가 한밤중에 보낸다
        .select({ id: projects.id, quietStartHour: projects.quietStartHour, quietEndHour: projects.quietEndHour, timezone: projects.timezone })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  if (!project) return fail("Project not found", 404);

  const idem = parseIdempotencyKey(req);
  if ("error" in idem) return fail(idem.error, 400);
  if (idem.key) {
    const existing = await findIdempotent(project.id, idem.key);
    if (existing) {
      return ok({ message: existing }, { scheduled: existing.status === "scheduled", idempotent_replay: true }, 200);
    }
  }

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, MESSAGE_BODY_LIMIT);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const prepared = await prepareMessage(project.id, b);
  if ("error" in prepared) return fail(prepared.error, prepared.status);

  const { message, scheduled, replay } = await enqueuePush(project, prepared.message, {
    sentBy: await senderOf(authz.ctx),
    idempotencyKey: idem.key,
  });
  // 발송은 되돌릴 수 없는 행위다 — 누가 무엇을 누구에게 보냈는지 남지 않으면 사후에 물을 방법이 없다.
  // 재요청(replay)은 새 발송이 아니므로 적지 않는다. 기록 실패가 발송 응답을 막지는 않는다(recordAudit 이 삼킨다).
  if (!replay) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      req,
      action: "send.create",
      targetType: "send",
      targetId: message.id,
      diff: buildDiff(null, {
        type: message.type,
        title: message.title,
        target: message.target ?? (message.targets?.length ? `${message.targets.length} recipients` : null),
        scheduledAt: message.scheduledAt?.toISOString() ?? null,
      }),
    });
  }
  return ok({ message }, replay ? { scheduled, idempotent_replay: true } : { scheduled }, replay ? 200 : 202);
}
