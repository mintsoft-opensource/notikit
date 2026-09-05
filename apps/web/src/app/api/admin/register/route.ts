import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers, organizations } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { hashPassword, createSessionToken, SESSION_COOKIE, sessionCookieAttributes } from "@/lib/session";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  org_name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

/** [Web Admin] 최초 관리자 부트스트랩 — 관리자가 0명일 때만 허용 */
export async function POST(req: Request) {
  const db = getDb();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(adminUsers);
  if (count > 0) return fail("이미 초기화되었습니다. 로그인하세요.", 403);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const org = (await db.insert(organizations).values({ name: b.org_name ?? "Notikit" }).returning())[0];
  const user = (
    await db
      .insert(adminUsers)
      .values({ orgId: org.id, email: b.email.toLowerCase(), passwordHash: hashPassword(b.password), role: "owner" })
      .returning({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role })
  )[0];

  const res = ok({ user: { email: user.email, role: user.role } }, undefined, 201);
  res.cookies.set(SESSION_COOKIE, createSessionToken({ userId: user.id, orgId: org.id, role: user.role }), sessionCookieAttributes());
  return res;
}
