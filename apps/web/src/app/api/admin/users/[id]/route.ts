import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth, checkOrigin, type AuthContext } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { ROLES, canAssignRole } from "@/lib/user-roles";
import { buildDiff, recordOrgAudit, DENIED_SUFFIX } from "@/lib/audit";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ role: z.enum(ROLES) });

type TargetRow = { id: string; orgId: string; role: string };

/**
 * 대상 사용자 조회 + 공통 인가.
 * - 세션 유저는 자기 org 멤버만 (타 org 는 존재 여부도 숨겨 404)
 * - owner 계정은 owner/superadmin 만 건드릴 수 있다
 *   (admin 이 owner 를 강등/삭제하면 스스로 최고 권한을 탈취하게 됨)
 */
async function loadTarget(
  ctx: AuthContext,
  id: string
): Promise<{ ok: true; target: TargetRow } | { ok: false; status: number; error: string }> {
  const db = getDb();
  const target = (
    await db.select({ id: adminUsers.id, orgId: adminUsers.orgId, role: adminUsers.role }).from(adminUsers).where(eq(adminUsers.id, id)).limit(1)
  )[0];
  if (!target) return { ok: false, status: 404, error: "User not found" };
  if (!ctx.superadmin && target.orgId !== ctx.orgId) return { ok: false, status: 404, error: "User not found" };
  if (target.role === "owner" && !ctx.superadmin && ctx.role !== "owner") {
    return { ok: false, status: 403, error: "Forbidden: owner 계정은 owner 만 변경할 수 있습니다" };
  }
  return { ok: true, target };
}

/** org 의 마지막 owner 가 사라지지 않도록 직렬화 검사 (동시 요청 경합 차단) */
async function withLastOwnerGuard<T>(orgId: string, targetIsOwner: boolean, run: () => Promise<T>): Promise<T | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // org 단위 advisory lock — 두 owner 를 동시에 지워 0명이 되는 경합 방지
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`);
    if (targetIsOwner) {
      const rows = (await tx.execute(
        sql`select count(*)::int as c from admin_users where org_id = ${orgId} and role = 'owner'`
      )) as unknown as Array<{ c: number }>;
      if (Number(rows[0]?.c ?? 0) <= 1) return null; // 마지막 owner
    }
    return run();
  });
}

/**
 * 멤버 쓰기 거부를 감사에 남기고 그대로 실패 응답을 돌려준다.
 *
 * 403 만 적는다 — 404("그 사람 없음")는 타 org 존재 여부를 숨기려고 만든 응답이라
 * 감사에 적으면 그 정보가 도로 새고, 401 은 인증 없는 요청이라 누구나 행을 밀어 넣을 수 있다.
 */
async function failMember(
  actor: AuthContext,
  action: string,
  targetId: string,
  denied: { status: number; error: string }
) {
  if (denied.status === 403 && actor.orgId) {
    await recordOrgAudit({
      orgId: actor.orgId,
      actor,
      action: `${action}${DENIED_SUFFIX}`,
      targetId,
      diff: { outcome: { before: "allowed", after: `denied (${denied.error})` } },
    });
  }
  return fail(denied.error, denied.status);
}

/** [Web Admin] 멤버 역할 변경 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);
  const { id } = await ctx.params;

  const loaded = await loadTarget(auth.ctx, id);
  if (!loaded.ok) return failMember(auth.ctx, "member.update", id, loaded);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = patchSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const role = parsed.data.role;

  if (!canAssignRole(auth.ctx, role)) {
    return failMember(auth.ctx, "member.update", id, { status: 403, error: "Forbidden: owner 는 owner 만 지정할 수 있습니다" });
  }
  // 자기 자신을 강등하면 그 자리에서 관리 권한을 잃는다 — 실수 방지
  if (auth.ctx.userId === id && role !== auth.ctx.role) return fail("자기 자신의 역할은 변경할 수 없습니다", 400);

  const demotingOwner = loaded.target.role === "owner" && role !== "owner";
  const updated = await withLastOwnerGuard(loaded.target.orgId, demotingOwner, async () => {
    const db = getDb();
    return (
      await db
        .update(adminUsers)
        .set({ role })
        .where(eq(adminUsers.id, id))
        .returning({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role })
    )[0];
  });
  if (!updated) return fail("마지막 owner 는 강등할 수 없습니다", 409);

  const diff = buildDiff({ role: loaded.target.role }, { role: updated.role });
  if (diff) {
    await recordOrgAudit({
      orgId: loaded.target.orgId,
      actor: auth.ctx,
      action: "member.update",
      targetId: updated.id,
      diff: { ...diff, email: { before: updated.email, after: updated.email } },
    });
  }
  return ok({ user: updated });
}

/** [Web Admin] 멤버 삭제 — 세션도 함께 무효화(행 삭제 → isSessionValid 실패) */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);
  const { id } = await ctx.params;

  // 자기 삭제는 즉시 로그아웃 + 복구 불가 — 차단
  if (auth.ctx.userId === id) return fail("자기 자신은 삭제할 수 없습니다", 400);

  const loaded = await loadTarget(auth.ctx, id);
  if (!loaded.ok) return failMember(auth.ctx, "member.delete", id, loaded);

  const deleted = await withLastOwnerGuard(loaded.target.orgId, loaded.target.role === "owner", async () => {
    const db = getDb();
    return (await db.delete(adminUsers).where(eq(adminUsers.id, id)).returning({ id: adminUsers.id, email: adminUsers.email }))[0];
  });
  if (!deleted) return fail("마지막 owner 는 삭제할 수 없습니다", 409);

  await recordOrgAudit({
    orgId: loaded.target.orgId,
    actor: auth.ctx,
    action: "member.delete",
    targetId: deleted.id,
    diff: buildDiff({ email: deleted.email, role: loaded.target.role }, null),
  });
  return ok({ deleted: true });
}
