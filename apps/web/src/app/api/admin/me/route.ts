import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { ok } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** [Web Admin] 현재 세션 + 부트스트랩 필요 여부 (login 페이지 분기용, 공개) */
export async function GET(req: Request) {
  const db = getDb();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(adminUsers);
  const needsBootstrap = count === 0;

  const ctx = await getAuthContext(req);
  if (!ctx) return ok({ authenticated: false, user: null, needsBootstrap });

  if (ctx.superadmin) return ok({ authenticated: true, user: { email: "superadmin", role: "owner" }, needsBootstrap: false });

  const user = (
    await db.select({ email: adminUsers.email, role: adminUsers.role }).from(adminUsers).where(eq(adminUsers.id, ctx.userId!)).limit(1)
  )[0];
  if (!user) return ok({ authenticated: false, user: null, needsBootstrap });

  return ok({ authenticated: true, user: { email: user.email, role: user.role }, needsBootstrap: false });
}
