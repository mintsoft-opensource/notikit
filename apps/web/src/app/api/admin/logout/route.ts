import { ok } from "@/lib/api-response";
import { SESSION_COOKIE, sessionCookieAttributes } from "@/lib/session";

export const dynamic = "force-dynamic";

/** [Web Admin] 로그아웃 — 세션 쿠키 제거 */
export async function POST() {
  const res = ok({ loggedOut: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieAttributes(0), maxAge: 0 });
  return res;
}
