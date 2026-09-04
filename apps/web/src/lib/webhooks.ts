import { and, eq, lt } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

const MAX_ATTEMPTS = 5;

async function attempt(db: Db, deliveryId: string, url: string, secret: string, event: string, envelope: string, attempts: number) {
  const signature = createHmac("sha256", secret).update(envelope).digest("hex");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notikit-event": event,
        "x-notikit-signature": `sha256=${signature}`,
      },
      body: envelope,
      signal: AbortSignal.timeout(10_000),
    });
    await db
      .update(webhookDeliveries)
      .set({ status: res.ok ? "delivered" : "failed", attempts: attempts + 1, lastStatusCode: res.status })
      .where(eq(webhookDeliveries.id, deliveryId));
    return res.ok;
  } catch {
    await db.update(webhookDeliveries).set({ status: "failed", attempts: attempts + 1 }).where(eq(webhookDeliveries.id, deliveryId));
    return false;
  }
}

/** 프로젝트의 구독 웹훅에 이벤트 발행 (HMAC 서명). 비동기·논블로킹으로 호출. */
export async function emitWebhook(projectId: string, event: string, data: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const hooks = await db.select().from(webhooks).where(and(eq(webhooks.projectId, projectId), eq(webhooks.isActive, true)));
  const matching = hooks.filter((h) => h.events.length === 0 || h.events.includes(event));

  await Promise.all(
    matching.map(async (h) => {
      const delivery = (await db.insert(webhookDeliveries).values({ webhookId: h.id, event, payload: data }).returning())[0];
      const envelope = JSON.stringify({ id: delivery.id, type: event, created_at: new Date().toISOString(), data });
      await attempt(db, delivery.id, h.url, h.secret, event, envelope, 0);
    })
  );
}

/** 실패 웹훅 재시도 (worker/cron). MAX_ATTEMPTS 미만 failed 를 재전송. */
export async function retryWebhooks(limit = 100): Promise<{ retried: number }> {
  const db = getDb();
  const rows = await db
    .select({ d: webhookDeliveries, wh: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)))
    .limit(limit);

  for (const { d, wh } of rows) {
    const envelope = JSON.stringify({ id: d.id, type: d.event, created_at: new Date().toISOString(), data: d.payload });
    await attempt(db, d.id, wh.url, wh.secret, d.event, envelope, d.attempts);
  }
  return { retried: rows.length };
}

export function generateWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, "")}`;
}
