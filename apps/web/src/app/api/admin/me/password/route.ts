import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { checkOrigin, requireAuth } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit } from "@/lib/rate-limit";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashPassword,
  verifyPassword,
  sessionCookieAttributes,
  ScryptOverloadError,
} from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(200),
});

/**
 * [Web Admin] 내 비밀번호 변경.
 * 성공 시 sessionVersion 을 올려 **다른 기기의 세션을 전부 끊고**, 현재 세션만 새 토큰으로 재발급한다.
 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (auth.ctx.superadmin || !auth.ctx.userId) return fail("세션 계정이 아닙니다", 400);

  // 현재 비밀번호 추측 시도 차단 (scrypt 검증 자체도 비싸다)
  if (!rateLimit(`me:password:${auth.ctx.userId}`, 5, 60_000)) return fail("잠시 후 다시 시도하세요", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;
  if (b.current_password === b.new_password) return fail("현재 비밀번호와 다른 값을 입력하세요", 422);

  const db = getDb();
  const user = (
    await db
      .select({ passwordHash: adminUsers.passwordHash, ver: adminUsers.sessionVersion })
      .from(adminUsers)
      .where(eq(adminUsers.id, auth.ctx.userId))
      .limit(1)
  )[0];
  if (!user) return fail("Unauthorized", 401);

  let okCurrent: boolean;
  let newHash: string;
  try {
    okCurrent = await verifyPassword(b.current_password, user.passwordHash);
    if (!okCurrent) return fail("현재 비밀번호가 올바르지 않습니다", 403);
    newHash = await hashPassword(b.new_password);
  } catch (e) {
    if (e instanceof ScryptOverloadError) return fail("일시적으로 혼잡합니다. 잠시 후 다시 시도하세요", 503);
    throw e;
  }

  // 버전이 그대로일 때만 갱신 — 동시 변경/로그아웃과 경합하면 실패시켜 재시도하게 한다
  const nextVer = user.ver + 1;
  const updated = await db
    .update(adminUsers)
    .set({ passwordHash: newHash, sessionVersion: nextVer })
    .where(and(eq(adminUsers.id, auth.ctx.userId), eq(adminUsers.sessionVersion, user.ver)))
    .returning({ id: adminUsers.id });
  if (updated.length === 0) return fail("세션이 변경되었습니다. 다시 시도하세요", 409);

  const res = ok({ changed: true });
  // 다른 기기는 끊고 현재 브라우저만 유지
  res.cookies.set(SESSION_COOKIE, createSessionToken({ userId: auth.ctx.userId, ver: nextVer }), sessionCookieAttributes());
  return res;
}
