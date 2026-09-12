import { and, eq, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { topics } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * 토픽 단건 — 상세 화면용.
 *
 * 모든 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 토픽을
 * id 추측만으로 읽거나 지울 수 있다.
 *
 * 이름 수정은 두지 않았다. `(project_id, name)` 이 유니크이고 SDK 구독이 이름으로
 * 걸려 있어서, 이름을 바꾸면 이미 구독한 기기가 조용히 다른 토픽을 보게 된다.
 */
async function load(projectId: string, topicId: string) {
  const db = getDb();
  return (
    await db
      .select()
      .from(topics)
      .where(and(eq(topics.id, topicId), eq(topics.projectId, projectId)))
      .limit(1)
  )[0];
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string; topicId: string }> }) {
  const { id, topicId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const row = await load(id, topicId);
  if (!row) return fail("Not found", 404);

  const db = getDb();
  // 구독 규모 — 지우기 전에 영향 범위를 알아야 한다
  const counts = await db
    .execute(
      raw`select count(*)::int as devices,
                 count(distinct d.user_id)::int as users
            from subscriptions s
            join devices d on d.id = s.device_id
           where s.topic_id = ${topicId}`
    )
    .catch(() => [{ devices: 0, users: 0 }]);
  const c = (counts as unknown as { devices: number; users: number }[])[0] ?? { devices: 0, users: 0 };

  return ok({ topic: row, deviceCount: c.devices, userCount: c.users });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; topicId: string }> }) {
  const { id, topicId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  // subscriptions 는 FK cascade 로 함께 지워진다 — 구독자들의 구독이 사라진다.
  const rows = await db
    .delete(topics)
    .where(and(eq(topics.id, topicId), eq(topics.projectId, id)))
    .returning({ id: topics.id });
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ deleted: rows[0].id });
}
