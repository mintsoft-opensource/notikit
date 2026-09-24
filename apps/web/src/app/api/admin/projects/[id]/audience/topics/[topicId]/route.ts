import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { topics } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { countTopicAudience, isRuleFilled, rulesSchema, toStoredRules } from "@/lib/topic-membership";
import { z } from "zod";

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

  /**
   * 그룹 규모 — 지우기 전에 영향 범위를 알아야 한다.
   *
   * 목록 라우트와 **같은 함수**로 센다. 조건이 갈리면 목록과 상세가 서로 다른 수를
   * 말하고, 두 화면의 삭제 확인 문구도 어긋난다.
   *
   * 실패를 0 으로 삼키지 않는다 — 이 값의 유일한 쓰임이 "몇 명이 끊기는지" 경고인데,
   * 0 으로 보이면 경고가 사라진 채 cascade 삭제가 진행된다.
   */
  const c = await countTopicAudience(getDb(), id, row);
  return ok({ topic: row, deviceCount: c.devices, userCount: c.users });
}

/**
 * 규칙 수정. **이름과 채우는 방식은 못 바꾼다.**
 *
 * 이름: `push_logs.target` 에 이름이 문자열로 남아서, 바꾸면 예약된 발송이 대상을
 * 못 찾고 조용히 0명에게 나간다. SDK 구독도 이름으로 걸려 있다.
 *
 * 방식: 구독식 ↔ 규칙식 전환은 기존 명단의 의미를 지운다. 새로 만들어야 한다.
 */
const updateSchema = z.object({ rules: rulesSchema });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; topicId: string }> }) {
  const { id, topicId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const current = await load(id, topicId);
  if (!current) return fail("Not found", 404);
  if (!isRuleFilled(current.rules)) return fail("Topic is subscription-filled — it has no rules to edit", 409);

  const db = getDb();
  const rows = await db
    .update(topics)
    .set({ rules: toStoredRules(parsed.data.rules) })
    .where(and(eq(topics.id, topicId), eq(topics.projectId, id)))
    .returning();
  return ok({ topic: rows[0] });
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
