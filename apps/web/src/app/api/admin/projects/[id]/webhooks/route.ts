import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { webhooks } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { generateWebhookSecret, assertSafeWebhookUrl } from "@/lib/webhooks";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** [Web Admin] 웹훅 목록 (secret 제외) */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  const db = getDb();
  const rows = await db
    .select({ id: webhooks.id, url: webhooks.url, events: webhooks.events, isActive: webhooks.isActive, createdAt: webhooks.createdAt })
    .from(webhooks)
    .where(eq(webhooks.projectId, id))
    .orderBy(desc(webhooks.createdAt));
  return ok({ webhooks: rows });
}

const createSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().max(64)).max(30).default([]),
});

/** [Web Admin] 웹훅 등록 — secret(HMAC) 1회 반환 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  try {
    await assertSafeWebhookUrl(parsed.data.url); // SSRF 방어 (호스트 + DNS 해석)
  } catch (e) {
    return fail(e instanceof Error ? e.message : "invalid url", 422);
  }

  const secret = generateWebhookSecret();
  const db = getDb();
  const row = (
    await db.insert(webhooks).values({ projectId: id, url: parsed.data.url, events: parsed.data.events, secret }).returning({
      id: webhooks.id,
      url: webhooks.url,
      events: webhooks.events,
    })
  )[0];
  return ok({ webhook: row, secret }, { note: "secret shown once" }, 201);
}
