import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { topics } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { buildDiff, failAudited, recordAudit } from "@/lib/audit";
import { countTopicAudience, isRuleFilled, rulesSchema, toStoredRules } from "@/lib/topic-membership";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * [Web Admin] 토픽 목록 — 구독 디바이스 수와 **고유 유저 수**를 함께 낸다.
 * 발송 대상은 디바이스지만 "몇 명이 구독했나"는 유저 기준이라 둘 다 필요하다.
 *
 * 구독식 수는 서브쿼리로 한 번에 세고, 규칙식 수는 토픽마다 조건이 달라 한 건씩 센다.
 * 규칙식 그룹은 프로젝트당 많아야 수십 개라 N+1 을 감수한다 — 목록 한 화면 분량이다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const rows = await db
    .select({
      id: topics.id,
      name: topics.name,
      rules: topics.rules,
      createdAt: topics.createdAt,
    })
    .from(topics)
    .where(eq(topics.projectId, id))
    .orderBy(desc(topics.createdAt));

  // 구독식·규칙식 모두 상세·발송 추정과 같은 함수로 센다. 목록만 따로 세면 수신 거부한 기기가
  // 목록에는 들어가고 발송에서는 빠져, 삭제 경고와 도달 인원이 서로 다른 숫자를 말한다.
  const withCounts = await Promise.all(
    rows.map(async (t) => {
      const c = await countTopicAudience(db, id, t);
      return { ...t, deviceCount: c.devices, userCount: c.users };
    })
  );

  return ok({ topics: withCounts });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // 없으면 구독식, 있으면 규칙식. 한 번 정하면 방식은 바뀌지 않는다(아래 PATCH 주석 참고).
  rules: rulesSchema.optional(),
});

/** [Web Admin] 토픽 생성 — SDK 구독 전에 콘솔에서 미리 만들 수 있게 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "topic.create", "topic", authz);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const { name, rules } = parsed.data;

  // 이름이 겹치면 덮어쓰지 않는다. 구독식 그룹에 규칙을 얹으면 이미 쌓인 구독이
  // 무시되고, 규칙식 그룹을 구독식으로 되돌리면 명단이 빈 채로 살아난다.
  // insert 를 먼저 시도한다 — 조회 후 insert 는 그 사이 SDK 가 만든 토픽을 놓친다.
  const created = (
    await db
      .insert(topics)
      .values({ projectId: id, name, rules: rules ? toStoredRules(rules) : null })
      .onConflictDoNothing({ target: [topics.projectId, topics.name] })
      .returning()
  )[0];
  if (created) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      action: "topic.create",
      targetType: "topic",
      targetId: created.id,
      diff: buildDiff(null, { name: created.name, rules: created.rules }),
    });
    return ok({ topic: created }, undefined, 201);
  }

  const existing = (
    await db
      .select()
      .from(topics)
      .where(and(eq(topics.projectId, id), eq(topics.name, name)))
      .limit(1)
  )[0];
  if (!existing) return fail("Topic was deleted concurrently — retry", 409, { code: "topic_deleted_retry" });
  const sameKind = isRuleFilled(existing.rules) === isRuleFilled(rules ?? null);
  if (!sameKind) return fail("A topic with this name already exists with a different fill mode", 409, { code: "topic_name_conflict" });
  // 같은 이름의 규칙식 토픽을 **다른 조건으로** 만들면 새 조건이 버려지는데 200 이면 콘솔이 "생성됨"을 띄운다.
  // 같은 요청의 재시도(조건까지 같음)만 200 으로 멱등 처리하고, 조건이 다르면 수정하라고 알린다.
  if (isRuleFilled(existing.rules) && stableJson(existing.rules) !== stableJson(rules ? toStoredRules(rules) : null)) {
    return fail("A topic with this name already exists with different rules — edit that topic instead", 409, {
      code: "topic_name_conflict",
    });
  }
  return ok({ topic: existing }, undefined, 200);
}

/** 키 순서와 무관한 JSON — jsonb 는 저장할 때 키 순서를 바꾸므로 그대로 비교하면 같은 규칙도 달라 보인다 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** [Web Admin] 토픽 삭제 — 구독은 cascade 로 함께 사라진다 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "topic.delete", "topic", authz);

  const name = new URL(req.url).searchParams.get("name");
  if (!name) return fail("name is required", 422);

  const db = getDb();
  // 지워진 내용을 returning 으로 함께 받는다 — id 만 받으면 "무엇이 사라졌는지" 를 복구할 수 없다
  const deleted = await db
    .delete(topics)
    .where(and(eq(topics.projectId, id), eq(topics.name, name)))
    .returning();
  if (deleted.length === 0) return fail("Topic not found", 404);
  for (const row of deleted) {
    await recordAudit({
      projectId: id,
      actor: authz.ctx,
      action: "topic.delete",
      targetType: "topic",
      targetId: row.id,
      diff: buildDiff({ name: row.name, rules: row.rules }, null),
    });
  }
  return ok({ deleted: deleted.length });
}
