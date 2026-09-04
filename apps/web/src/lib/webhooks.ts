import { and, eq, lt } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

const MAX_ATTEMPTS = 5;

/** 전역 유니캐스트(공인) IP 만 허용 — 루프백/사설/링크로컬/ULA/예약/매핑 전부 차단 (ipaddr.js) */
function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // 파싱 불가 → 차단
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() !== "unicast";
}

/** SSRF 방어 — https 강제 + 호스트/DNS해석 IP 를 공인 유니캐스트로 제한. DNS 실패 시 차단(fail-closed) */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "https:") throw new Error("webhook url must be https");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new Error("webhook url host not allowed");
  }
  // IP 리터럴이면 직접 검사
  if (ipaddr.isValid(host) && isBlockedIp(host)) throw new Error("webhook url host not allowed (private/loopback)");
  // 호스트명이면 DNS 해석 후 검사 (실패/무응답 시 차단)
  if (!ipaddr.isValid(host)) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new Error("webhook url dns lookup failed");
    }
    if (addrs.length === 0) throw new Error("webhook url has no dns records");
    for (const a of addrs) if (isBlockedIp(a.address)) throw new Error("webhook url resolves to a non-public address");
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
