import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { verifyPassword, createSessionToken, SESSION_COOKIE, sessionCookieAttributes } from "@/lib/session";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email().max(255), password: z.string().min(1).max(200) });

/** [Web Admin] 로그인 — 이메일/비밀번호 → 세션 쿠키 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail("이메일/비밀번호를 확인하세요", 422);

  const db = getDb();
  const user = (
    await db.select().from(adminUsers).where(eq(adminUsers.email, parsed.data.email.toLowerCase())).limit(1)
  )[0];

  // 타이밍 방어: 유저 없음/비번 불일치 동일 처리
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return fail("이메일 또는 비밀번호가 올바르지 않습니다", 401);
  }

  const res = ok({ user: { email: user.email, role: user.role } });
  res.cookies.set(SESSION_COOKIE, createSessionToken({ userId: user.id, orgId: user.orgId, role: user.role }), sessionCookieAttributes());
  return res;
}
