import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { SESSION_COOKIE, sessionCookieAttributes, sessionTokenFromRequest } from "@/lib/session";
import { checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 로그아웃 — sessionVersion 증가로 발급 토큰 전부 무효화 + 쿠키 제거 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);

  const st = sessionTokenFromRequest(req);
  if (st) {
    // 현재 버전과 일치할 때만 증가 → 이미 로그아웃된 쿠키 리플레이가 새 세션을 무효화하지 못함
    await getDb()
      .update(adminUsers)
      .set({ sessionVersion: sql`${adminUsers.sessionVersion} + 1` })
      .where(and(eq(adminUsers.id, st.userId), eq(adminUsers.sessionVersion, st.ver)));
  }

  const res = ok({ loggedOut: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieAttributes(0), maxAge: 0 });
  return res;
}
