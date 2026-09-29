import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers, organizations } from "@/db/schema";
import { bootstrapToken } from "@/lib/bootstrap-token";
import { ok, fail } from "@/lib/api-response";
import { hashPassword, createSessionToken, SESSION_COOKIE, sessionCookieAttributes, ScryptOverloadError } from "@/lib/session";
import { checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimitShared } from "@/lib/rate-limit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  org_name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

/**
 * [Web Admin] 최초 관리자 부트스트랩 — 관리자가 0명일 때만.
 * - 운영에서는 x-bootstrap-token 헤더가 필요하다(무단 선점 방지). BOOTSTRAP_TOKEN 이 없으면
 *   암호화 키에서 파생한 값이고 부팅 로그에 찍힌다(bootstrap-token.ts).
 * - advisory lock + 트랜잭션으로 동시 요청 경합 차단.
 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);

  const required = bootstrapToken();
  if (required && req.headers.get("x-bootstrap-token") !== required) {
    return fail("부트스트랩 토큰이 필요합니다", 403);
  }

  // rate limit 을 DB 조회 이전에 (비싼 count/해싱 남용 방어)
  if (!await rateLimitShared("auth:register", 20, 60_000)) return fail("잠시 후 다시 시도하세요", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  // 이미 초기화된 설치에서 비싼 해싱을 피하기 위한 사전 체크 (권위 있는 검증은 아래 트랜잭션)
  const [{ count: pre }] = await db.select({ count: sql<number>`count(*)::int` }).from(adminUsers);
  if (pre > 0) return fail("이미 초기화되었습니다. 로그인하세요.", 403);

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(b.password); // 락 밖에서 (비싼 연산)
  } catch (e) {
    if (e instanceof ScryptOverloadError) return fail("일시적으로 혼잡합니다. 잠시 후 다시 시도하세요", 503);
    throw e;
  }

  let created: { id: string; email: string; role: string; orgId: string } | null = null;
  try {
    await db.transaction(async (tx) => {
      // 부트스트랩 직렬화 (동시 요청 중 하나만 진입)
      await tx.execute(sql`select pg_advisory_xact_lock(918273645)`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(adminUsers);
      if (count > 0) throw new Error("ALREADY_INITIALIZED");

      const org = (await tx.insert(organizations).values({ name: b.org_name ?? "Notikit" }).returning())[0];
      const user = (
        await tx
          .insert(adminUsers)
          .values({ orgId: org.id, email: b.email.toLowerCase(), passwordHash, role: "owner" })
          .returning({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role })
      )[0];
      created = { ...user, orgId: org.id };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "ALREADY_INITIALIZED") return fail("이미 초기화되었습니다. 로그인하세요.", 403);
    throw e;
  }

  const user = created!;
  const res = ok({ user: { email: user.email, role: user.role } }, undefined, 201);
  res.cookies.set(SESSION_COOKIE, createSessionToken({ userId: user.id, ver: 0 }), sessionCookieAttributes());
  return res;
}
