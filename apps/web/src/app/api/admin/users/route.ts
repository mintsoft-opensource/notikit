import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminUsers, organizations } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth, checkOrigin } from "@/lib/authz";
import { ROLES, canAssignRole } from "@/lib/user-roles";
import { hashPassword, ScryptOverloadError } from "@/lib/session";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimitShared } from "@/lib/rate-limit";
import { buildDiff, recordOrgAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES).default("viewer"),
  /** superadmin 전용 — 세션 유저는 항상 자기 org */
  org_id: z.string().uuid().optional(),
});

/** [Web Admin] org 멤버 목록 — 비밀번호 해시는 절대 내려보내지 않는다 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);

  const db = getDb();
  const base = db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      role: adminUsers.role,
      orgId: adminUsers.orgId,
      createdAt: adminUsers.createdAt,
    })
    .from(adminUsers)
    .$dynamic();

  const rows = auth.ctx.superadmin
    ? await base.orderBy(asc(adminUsers.createdAt)).limit(500)
    : await base.where(eq(adminUsers.orgId, auth.ctx.orgId!)).orderBy(asc(adminUsers.createdAt)).limit(500);

  return ok({ users: rows.map((u) => ({ ...u, isSelf: u.id === auth.ctx.userId })) });
}

/** [Web Admin] 멤버 추가 — owner/admin 만, 자기 org 에만, owner 생성은 owner 만 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);

  // scrypt 는 의도적으로 비싼 연산 — 생성 요청은 반드시 제한
  if (!await rateLimitShared(`admin:users:create:${auth.ctx.userId ?? "superadmin"}`, 10, 60_000)) {
    return fail("Rate limit exceeded", 429);
  }

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  if (!canAssignRole(auth.ctx, b.role)) return fail("Forbidden: owner 는 owner 만 생성할 수 있습니다", 403);

  // 세션 유저는 org_id 를 지정할 수 없다(타 org 침투 방지). superadmin 만 대상 org 선택.
  const orgId = auth.ctx.superadmin ? b.org_id : auth.ctx.orgId!;
  if (!orgId) return fail("org_id is required", 422);

  const db = getDb();
  if (auth.ctx.superadmin) {
    const org = (await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).limit(1))[0];
    if (!org) return fail("Organization not found", 404);
  }

  const email = b.email.toLowerCase();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(b.password);
  } catch (e) {
    if (e instanceof ScryptOverloadError) return fail("일시적으로 혼잡합니다. 잠시 후 다시 시도하세요", 503);
    throw e;
  }

  try {
    const user = (
      await db
        .insert(adminUsers)
        .values({ orgId, email, passwordHash, role: b.role })
        .returning({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role, createdAt: adminUsers.createdAt })
    )[0];
    // 비밀번호는 넘기지 않는다(해시조차). 남겨야 하는 건 "누가 누구를 어떤 권한으로 들였나" 다.
    await recordOrgAudit({
      orgId,
      actor: auth.ctx,
      action: "member.create",
      targetId: user.id,
      diff: buildDiff(null, { email: user.email, role: user.role }),
    });
    return ok({ user }, undefined, 201);
  } catch (e) {
    // email 은 전역 unique index — 타 org 존재 여부를 노출하지 않도록 동일 메시지
    if (e instanceof Error && /duplicate key|unique/i.test(e.message)) {
      return fail("이미 사용 중인 이메일입니다", 409);
    }
    throw e;
  }
}
