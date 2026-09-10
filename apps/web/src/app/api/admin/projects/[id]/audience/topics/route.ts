import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { topics } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * [Web Admin] 토픽 목록 — 구독 디바이스 수와 **고유 유저 수**를 함께 낸다.
 * 발송 대상은 디바이스지만 "몇 명이 구독했나"는 유저 기준이라 둘 다 필요하다.
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
      createdAt: topics.createdAt,
      // 서브쿼리 안에서는 별칭을 쓴다 — 바깥 topics.id 와 devices.id 가 섞여
      // "column reference id is ambiguous" 로 터진다
      deviceCount: sql<number>`(
        select count(*)::int from subscriptions s
        join devices d on d.id = s.device_id
        where s.topic_id = topics.id and d.is_active = true
      )`,
      userCount: sql<number>`(
        select count(distinct d.user_id)::int from subscriptions s
        join devices d on d.id = s.device_id
        where s.topic_id = topics.id and d.is_active = true
      )`,
    })
    .from(topics)
    .where(eq(topics.projectId, id))
    .orderBy(desc(topics.createdAt));

  return ok({ topics: rows });
}

const createSchema = z.object({ name: z.string().min(1).max(120) });

/** [Web Admin] 토픽 생성 — SDK 구독 전에 콘솔에서 미리 만들 수 있게 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const row = (
    await db
      .insert(topics)
      .values({ projectId: id, name: parsed.data.name })
      .onConflictDoUpdate({ target: [topics.projectId, topics.name], set: { name: parsed.data.name } })
      .returning()
  )[0];
  return ok({ topic: row }, undefined, 201);
}

/** [Web Admin] 토픽 삭제 — 구독은 cascade 로 함께 사라진다 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const name = new URL(req.url).searchParams.get("name");
  if (!name) return fail("name is required", 422);

  const db = getDb();
  const deleted = await db
    .delete(topics)
    .where(and(eq(topics.projectId, id), eq(topics.name, name)))
    .returning({ id: topics.id });
  if (deleted.length === 0) return fail("Topic not found", 404);
  return ok({ deleted: deleted.length });
}
