import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

const LIMIT = 30;
const statusSchema = z.enum(["pending", "delivered", "failed"]);
const uuidRe = /^[0-9a-f-]{36}$/i;

/**
 * [Web Admin] 웹훅 한 개의 배달 이력 — 최신순, (시각, id) 커서.
 *
 * 웹훅이 이 프로젝트 소속인지 먼저 확인한다. webhookId 만으로 찾으면 다른 프로젝트의
 * 이벤트 흐름을 id 추측으로 볼 수 있다. payload 는 내보내지 않는다(목록에 필요 없음).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; webhookId: string }> }) {
  const { id, webhookId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  if (!uuidRe.test(webhookId)) return fail("Webhook not found", 404);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? statusSchema.safeParse(statusParam) : null;
  if (status && !status.success) return fail("status must be pending, delivered or failed", 422);
  const cursor = parseCursor(url);

  const db = getDb();
  const hook = (
    await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, id)))
      .limit(1)
  )[0];
  if (!hook) return fail("Webhook not found", 404);

  const conds = [eq(webhookDeliveries.webhookId, webhookId)];
  if (status?.success) conds.push(eq(webhookDeliveries.status, status.data));
  if (cursor) conds.push(beforeCursor(webhookDeliveries.createdAt, webhookDeliveries.id, cursor));

  const rows = await db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      createdAt: webhookDeliveries.createdAt,
      cursorTs: cursorExpr(webhookDeliveries.createdAt),
    })
    .from(webhookDeliveries)
    .where(and(...conds))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const page = rows.slice(0, LIMIT);
  return ok({
    deliveries: page.map(({ cursorTs: _c, ...r }) => r),
    next: nextCursor(page, hasMore),
  });
}
