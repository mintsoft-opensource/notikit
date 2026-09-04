import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notifications, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { verifyIdentity } from "@/lib/keys";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/** In-app 인박스 조회 — 유저 본인만 (identity_hash 검증으로 IDOR 방지) */
export async function GET(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id))) return fail("Rate limit exceeded", 429);

  const params = new URL(req.url).searchParams;
  const externalId = params.get("external_id");
  const identityHash = params.get("identity_hash");
  if (!externalId) return fail("external_id required", 422);
  // 인박스는 타 유저 데이터 노출 위험 → identity_hash 항상 필수(프로젝트 플래그와 무관)
  if (!identityHash || !verifyIdentity(externalId, identityHash, project.apiSecretEnc)) {
    return fail("identity_hash invalid or missing", 403);
  }

  const db = getDb();
  const user = (
    await db.select({ id: pushUsers.id }).from(pushUsers)
      .where(and(eq(pushUsers.projectId, project.id), eq(pushUsers.externalId, externalId))).limit(1)
  )[0];
  if (!user) return ok({ notifications: [], unread: 0 });

  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.projectId, project.id), eq(notifications.userId, user.id)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  const unread = rows.filter((r) => !r.readAt).length;
  return ok({ notifications: rows, unread });
}
