import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin, type AuthContext } from "@/lib/authz";
import { cancelDto, cancelPushLog } from "@/lib/push-cancel";
import { buildDiff, recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** 취소한 사람 — 세션이면 멤버 이메일, 서버-투-서버(x-admin-token)면 "admin-token" */
async function actorOf(ctx: AuthContext): Promise<string> {
  if (ctx.superadmin || !ctx.userId) return "admin-token";
  const row = (
    await getDb().select({ email: adminUsers.email }).from(adminUsers).where(eq(adminUsers.id, ctx.userId)).limit(1)
  )[0];
  return row?.email ?? "unknown";
}

/**
 * [Web Admin] 발송 취소 — 대기·예약·진행 중인 발송을 멈춘다.
 *
 * 응답은 **이미 나간 수를 반드시 함께 준다**. "취소됨"만 보여 주면 운영자는 아무에게도 안 갔다고
 * 읽는데, 대형 발송은 취소 버튼을 누르는 순간 이미 수만 건이 나간 뒤일 수 있다.
 *
 * 끝난 발송(completed/logged/failed)과 이미 취소된 것은 409 — 되돌릴 것이 없다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; logId: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const { id, logId } = await ctx.params;
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const outcome = await cancelPushLog(getDb(), id, logId, await actorOf(authz.ctx));
  if (!outcome.ok) {
    return outcome.reason === "not_found"
      ? fail("Not found", 404)
      : fail(`Message is already ${outcome.status} and cannot be canceled`, 409);
  }
  // 취소는 캠페인을 중간에 끊는 행위다 — **이미 나간 수까지** 남겨야 사후에 "왜 일부만 갔나"를
  // 설명할 수 있다. 기록이 실패해도 취소 자체는 성공으로 돌려준다(recordAudit 이 예외를 삼킨다).
  await recordAudit({
    projectId: id,
    actor: authz.ctx,
    req,
    action: "send.cancel",
    targetType: "send",
    targetId: logId,
    diff: buildDiff({ status: "in flight" }, { status: "canceled", ...outcome.sent }),
  });
  return ok({ log: cancelDto(outcome.log, outcome.sent) });
}
