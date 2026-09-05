import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { verifyPassword, dummyVerify, createSessionToken, SESSION_COOKIE, sessionCookieAttributes } from "@/lib/session";
import { checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit } from "@/lib/rate-limit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email().max(255), password: z.string().min(1).max(200) });

/** [Web Admin] 로그인 — 이메일/비밀번호 → 세션 쿠키 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail("이메일/비밀번호를 확인하세요", 422);
  const email = parsed.data.email.toLowerCase();

  // 계정별 시도 제한 (비싼 해시 연산 전에 차단)
  if (!rateLimit(`login:${email}`, 10, 60_000)) return fail("잠시 후 다시 시도하세요", 429);

  const db = getDb();
  const user = (await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1))[0];

  // 존재하지 않는 계정도 동일 비용 지불 (타이밍/존재여부 노출 방어)
  if (!user) {
    await dummyVerify(parsed.data.password);
    return fail("이메일 또는 비밀번호가 올바르지 않습니다", 401);
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return fail("이메일 또는 비밀번호가 올바르지 않습니다", 401);
  }

  const res = ok({ user: { email: user.email, role: user.role } });
  res.cookies.set(SESSION_COOKIE, createSessionToken({ userId: user.id, ver: user.sessionVersion }), sessionCookieAttributes());
  return res;
}
