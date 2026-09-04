import { and, eq, lt } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

const MAX_ATTEMPTS = 5;

function isPrivateAddress(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : s;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(v4) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(v4);
}

/** SSRF 방어 — https 강제 + 호스트/해석 IP 사설·루프백·메타데이터 차단 (IPv6/브래킷 포함) */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "https:") throw new Error("webhook url must be https");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase(); // IPv6 브래킷 제거
  const blockedHost = host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal";
  if (blockedHost || isPrivateAddress(host)) throw new Error("webhook url host not allowed (private/loopback/metadata)");
  // DNS 해석 후 사설 IP 차단 (rebinding 완화)
  const addrs = await lookup(host, { all: true }).catch(() => [] as { address: string }[]);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error("webhook url resolves to a private/loopback address");
  }
}

async function attempt(db: Db, deliveryId: string, url: string, secret: string, event: string, envelope: string, attempts: number) {
  const signature = createHmac("sha256", secret).update(envelope).digest("hex");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-notikit-event": event, "x-notikit-signature": `sha256=${signature}` },
      body: envelope,
      redirect: "error", // 리다이렉트(사설 대상)로의 우회 차단
      signal: AbortSignal.timeout(10_000),
    });
    await db.update(webhookDeliveries).set({ status: res.ok ? "delivered" : "failed", attempts: attempts + 1, lastStatusCode: res.status }).where(eq(webhookDeliveries.id, deliveryId));
    return res.ok;
  } catch {
    await db.update(webhookDeliveries).set({ status: "failed", attempts: attempts + 1 }).where(eq(webhookDeliveries.id, deliveryId));
    return false;
  }
}

/** 프로젝트의 구독 웹훅에 이벤트 발행 (HMAC 서명). 비동기·논블로킹. */
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

/** 실패 웹훅 재시도 — **프로젝트 스코프** + 원자적 클레임(중복 재전송 방지). */
export async function retryWebhooks(projectId: string, limit = 100): Promise<{ retried: number }> {
  const db = getDb();
  const rows = await db
    .select({ d: webhookDeliveries, wh: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(and(eq(webhooks.projectId, projectId), eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)))
    .limit(limit);

  let retried = 0;
  for (const { d, wh } of rows) {
    // 원자적 클레임: failed → retrying (다른 워커와 중복 방지)
    const claimed = await db.update(webhookDeliveries).set({ status: "retrying" }).where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, "failed"))).returning({ id: webhookDeliveries.id });
    if (claimed.length === 0) continue;
    const envelope = JSON.stringify({ id: d.id, type: d.event, created_at: new Date().toISOString(), data: d.payload });
    await attempt(db, d.id, wh.url, wh.secret, d.event, envelope, d.attempts);
    retried += 1;
  }
  return { retried };
}

export function generateWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, "")}`;
}
