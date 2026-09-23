import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";
import { safeFetch, validateAndResolve } from "@/lib/safe-fetch";

type Db = ReturnType<typeof getDb>;

export const MAX_ATTEMPTS = 5;
/** 첫 재시도까지의 간격. 이후 RETRY_FACTOR 배씩 — 1분 · 5분 · 25분 · 125분 */
export const RETRY_BASE_MS = 60_000;
export const RETRY_FACTOR = 5;
/** 재시도 후보 상태. `retrying` 도 포함 — 아래 "클레임=시도 소비" 참고 */
const RETRY_STATUSES = ["failed", "retrying"];
/** 한 번의 스윕이 붙잡고 있을 시간 상한 (워커 요청 타임아웃보다 충분히 짧게) */
const SWEEP_BUDGET_MS = 30_000;
const SWEEP_CONCURRENCY = 8;

/** SSRF 검증(관리자 등록 시점) — 실패 시 throw. 실제 전송은 safeFetch 가 IP 핀닝으로 재보장. */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  await validateAndResolve(raw);
}

/** attempts 회 실패한 배달의 다음 재시도까지 간격 */
export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * RETRY_FACTOR ** Math.max(0, attempts - 1);
}

/**
 * 실패 시각 기준 다음 재시도 허용 시각.
 * 기준점이 "직전 시도"라서, 워커가 오래 멈췄다 떠도 남은 시도를 한꺼번에 태우지 않는다.
 */
export function retryEligibleAt(failedAt: Date, attempts: number): Date {
  return new Date(failedAt.getTime() + retryDelayMs(attempts));
}

/** `next_attempt_at` 이 NULL 이면 이 컬럼 이전에 쌓인 행 — 즉시 대상으로 본다. */
export function isRetryEligible(nextAttemptAt: Date | null, attempts: number, now = Date.now()): boolean {
  return attempts < MAX_ATTEMPTS && (nextAttemptAt === null || now >= nextAttemptAt.getTime());
}

/** isRetryEligible 의 SQL 판 — 부분 인덱스(next_attempt_at, attempts)를 그대로 탄다. */
const eligibleSql = sql.raw(`(webhook_deliveries.next_attempt_at is null or webhook_deliveries.next_attempt_at <= now())`);

async function attempt(
  db: Db,
  deliveryId: string,
  url: string,
  secret: string,
  event: string,
  envelope: string,
  attempts: number
): Promise<boolean> {
  const signature = createHmac("sha256", secret).update(envelope).digest("hex");
  try {
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-notikit-event": event, "x-notikit-signature": `sha256=${signature}` },
      body: envelope,
      signal: AbortSignal.timeout(10_000),
    });
    await db
      .update(webhookDeliveries)
      .set({
        status: res.ok ? "delivered" : "failed",
        attempts,
        lastStatusCode: res.status,
        // 성공하면 예약을 지운다 — 남겨 두면 인덱스에 죽은 행이 쌓인다
        nextAttemptAt: res.ok ? null : retryEligibleAt(new Date(), attempts),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return res.ok;
  } catch {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", attempts, nextAttemptAt: retryEligibleAt(new Date(), attempts) })
      .where(eq(webhookDeliveries.id, deliveryId));
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
      await attempt(db, delivery.id, h.url, h.secret, event, envelope, 1);
    })
  );
}

type Candidate = {
  id: string;
  event: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  createdAt: Date;
  url: string;
  secret: string;
};

function candidates(db: Db, where: ReturnType<typeof and>, limit: number): Promise<Candidate[]> {
  return db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      createdAt: webhookDeliveries.createdAt,
      url: webhooks.url,
      secret: webhooks.secret,
    })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(and(eq(webhooks.isActive, true), inArray(webhookDeliveries.status, RETRY_STATUSES), lt(webhookDeliveries.attempts, MAX_ATTEMPTS), eligibleSql, where))
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(limit);
}

/**
 * 한 건을 클레임하고 재전송한다. 클레임에 실패하면(다른 워커가 가져감) false.
 *
 * 클레임은 `status`·`attempts` 를 CAS 하면서 attempts 를 올리고 `next_attempt_at` 을 다음 창으로 민다.
 * 이게 리스 역할을 한다 — 전송 도중 프로세스가 죽어 `retrying` 으로 남은 행도 그 창이 지나면
 * 회수되고, 그 전에는 다른 워커가 같은 건을 다시 쏘지 않는다.
 */
async function claimAndDeliver(db: Db, row: Candidate): Promise<boolean> {
  const next = row.attempts + 1;
  const claimed = await db
    .update(webhookDeliveries)
    .set({ status: "retrying", attempts: next, nextAttemptAt: retryEligibleAt(new Date(), next) })
    .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, row.status), eq(webhookDeliveries.attempts, row.attempts)))
    .returning({ id: webhookDeliveries.id });
  if (claimed.length === 0) return false;

  const envelope = JSON.stringify({ id: row.id, type: row.event, created_at: new Date().toISOString(), data: row.payload });
  await attempt(db, row.id, row.url, row.secret, row.event, envelope, next);
  return true;
}

/** 동시성 제한 실행 — 느린 엔드포인트 하나가 스윕 전체를 붙잡지 않게 */
async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(lanes);
}

async function deliverAll(db: Db, rows: Candidate[], deadline: number): Promise<{ retried: number; skipped: number }> {
  let retried = 0;
  let skipped = 0;
  await runLimited(rows, SWEEP_CONCURRENCY, async (row) => {
    // 예산을 넘겼으면 **클레임하지 않는다** — 클레임만 하고 못 보내면 시도 하나가 헛돈다
    if (Date.now() >= deadline) {
      skipped += 1;
      return;
    }
    try {
      if (await claimAndDeliver(db, row)) retried += 1;
      else skipped += 1;
    } catch (e) {
      skipped += 1;
      console.warn(`[webhooks] delivery ${row.id} failed to retry: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { retried, skipped };
}

/** 실패 웹훅 재시도 — **프로젝트 스코프** + 원자적 클레임(중복 재전송 방지). */
export async function retryWebhooks(projectId: string, limit = 100): Promise<{ retried: number; skipped: number }> {
  const db = getDb();
  const rows = await candidates(db, and(eq(webhooks.projectId, projectId)), limit);
  return deliverAll(db, rows, Date.now() + SWEEP_BUDGET_MS);
}

/**
 * 전 프로젝트 재시도 스윕 — 워커가 주기적으로 한 번만 부른다(프로젝트 수만큼 호출하지 않게).
 * 여러 워커가 동시에 돌아도 안전하다: 행 단위 CAS 클레임으로 한 명만 가져간다.
 */
export async function sweepWebhookRetries(
  opts: { limit?: number; budgetMs?: number } = {}
): Promise<{ retried: number; skipped: number; candidates: number }> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const deadline = Date.now() + Math.min(Math.max(opts.budgetMs ?? SWEEP_BUDGET_MS, 1_000), 120_000);
  const rows = await candidates(db, undefined, limit);
  const result = await deliverAll(db, rows, deadline);
  return { ...result, candidates: rows.length };
}

export function generateWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, "")}`;
}
