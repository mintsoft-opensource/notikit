import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";
import { errorMessage, log } from "@/lib/logger";
import { addSharedCounter } from "@/lib/redis";
import { safeFetch, validateAndResolve } from "@/lib/safe-fetch";
import { mapLimit } from "@/lib/send-dispatch";

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
/**
 * 이만큼 지난 `pending` 은 "전송 직후 죽어서 아무도 손대지 않은 행"으로 본다.
 *
 * emitWebhook 은 행을 넣고 **같은 요청 안에서** 한 번 쏜다(타임아웃 10초). 그 사이에 프로세스가
 * 죽으면 행은 영원히 `pending` 으로 남고, 재시도 후보 질의는 failed/retrying 만 보므로 아무도
 * 집어 가지 않는다. 전송 타임아웃보다 넉넉히 길게 잡아, 지금 정상적으로 날아가는 중인 건을
 * 두 번 보내지 않는다.
 */
const PENDING_STALE_MS = 120_000;

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

/**
 * isRetryEligible 의 SQL 판.
 *
 * 부분 인덱스 `webhook_deliveries_sweep_idx` 는 (next_attempt_at, attempts) 에 걸려 있고
 * 조건자가 `status in ('failed','retrying')` 이다(마이그레이션 0025 가 0024 의
 * `webhook_deliveries_retry_idx`(status = 'failed')를 이걸로 갈아 끼웠다). 재시도 후보 질의는
 * **그 조건자와 정확히 같은 status 집합**을 쓰므로 인덱스를 탄다.
 * 아래 stale `pending` 질의는 이 인덱스 밖이다 — 대신 created_at 컷오프로 범위를 좁히고,
 * pending 은 평소 거의 비어 있으므로(정상 경로에서 즉시 delivered/failed 로 넘어간다) 비용이 작다.
 */
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

/**
 * 발행하는 이벤트 이름. 웹훅 등록은 이 목록만 받는다 — 자유 입력이면 오타 난 이름이 저장되고
 * 그 웹훅은 영원히 한 번도 불리지 않는다(빈 목록은 "전부"다).
 */
export const WEBHOOK_EVENTS = ["message.sent"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** 프로젝트의 구독 웹훅에 이벤트 발행 (HMAC 서명). 비동기·논블로킹. */
export async function emitWebhook(projectId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
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

function selectCandidates(db: Db, filter: ReturnType<typeof and>, limit: number): Promise<Candidate[]> {
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
    .where(filter)
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(limit);
}

/**
 * 백오프가 찬 재시도 후보.
 * status 집합은 부분 인덱스 `webhook_deliveries_sweep_idx` 의 조건자와 **정확히 같아야** 한다
 * (마이그레이션 0025: `status in ('failed','retrying')`). 어긋나면 인덱스를 놓치고 풀스캔이 된다.
 */
export function retryFilter(where?: ReturnType<typeof and>) {
  return and(
    eq(webhooks.isActive, true),
    inArray(webhookDeliveries.status, RETRY_STATUSES),
    lt(webhookDeliveries.attempts, MAX_ATTEMPTS),
    eligibleSql,
    where
  );
}

/**
 * 삽입 직후 프로세스가 죽어 아무도 손대지 않은 `pending`.
 * 재시도 후보 질의가 failed/retrying 만 보기 때문에, 이 질의가 없으면 이 행들은 영원히 남는다.
 */
export function stalePendingFilter(now: Date, where?: ReturnType<typeof and>) {
  return and(
    eq(webhooks.isActive, true),
    eq(webhookDeliveries.status, "pending"),
    lt(webhookDeliveries.attempts, MAX_ATTEMPTS),
    lt(webhookDeliveries.createdAt, new Date(now.getTime() - PENDING_STALE_MS)),
    where
  );
}

/**
 * 스윕 후보 = 백오프가 찬 재시도 + **버려진 pending**.
 *
 * 둘을 한 질의로 OR 하지 않는다. 그러면 재시도 쪽이 부분 인덱스를 놓치고 매번 테이블을 훑는다.
 * 각자 자기 인덱스로 뽑아 합친 뒤, 오래된 것부터 limit 만큼 자른다.
 */
async function candidates(db: Db, where: ReturnType<typeof and>, limit: number, now = new Date()): Promise<Candidate[]> {
  const [retries, orphans] = await Promise.all([
    selectCandidates(db, retryFilter(where), limit),
    selectCandidates(db, stalePendingFilter(now, where), limit),
  ]);

  if (orphans.length === 0) return retries;
  return [...retries, ...orphans].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit);
}

/**
 * 한 건을 클레임하고 재전송한다. 클레임에 실패하면(다른 워커가 가져감) false.
 *
 * 클레임은 `status`·`attempts` 를 CAS 하면서 attempts 를 올리고 `next_attempt_at` 을 다음 창으로 민다.
 * 이게 리스 역할을 한다 — 전송 도중 프로세스가 죽어 `retrying` 으로 남은 행도 그 창이 지나면
 * 회수되고, 그 전에는 다른 워커가 같은 건을 다시 쏘지 않는다.
 */
async function claimAndDeliver(db: Db, row: Candidate): Promise<{ claimed: boolean; dead: boolean }> {
  const next = row.attempts + 1;
  const claimed = await db
    .update(webhookDeliveries)
    .set({ status: "retrying", attempts: next, nextAttemptAt: retryEligibleAt(new Date(), next) })
    .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, row.status), eq(webhookDeliveries.attempts, row.attempts)))
    .returning({ id: webhookDeliveries.id });
  if (claimed.length === 0) return { claimed: false, dead: false };

  const envelope = JSON.stringify({ id: row.id, type: row.event, created_at: new Date().toISOString(), data: row.payload });
  const delivered = await attempt(db, row.id, row.url, row.secret, row.event, envelope, next);
  // 시도를 다 쓴 실패는 여기서 조용히 멈춘다 — 세고 남기지 않으면 아무도 모른다
  if (!delivered && next >= MAX_ATTEMPTS) {
    recordDeadLetter(row);
    return { claimed: true, dead: true };
  }
  return { claimed: true, dead: false };
}

// ── 데드레터 관측 ──
const deadLetter = { total: 0, lastAt: null as number | null, lastId: null as string | null, lastEvent: null as string | null };

/**
 * MAX_ATTEMPTS 를 소진한 배달. 상태는 `failed` 로 남으므로 콘솔의 배달 이력에서
 * attempts = MAX_ATTEMPTS 로 그대로 보이고, 운영은 아래 카운터로 총량을 본다.
 */
function recordDeadLetter(row: Candidate): void {
  deadLetter.total += 1;
  deadLetter.lastAt = Date.now();
  deadLetter.lastId = row.id;
  deadLetter.lastEvent = row.event;
  // 프로세스 카운터는 replica 의 조각일 뿐이다 — 클러스터 합계는 Redis 에 따로 모은다
  addSharedCounter("webhook.dead_letter");
  log.error("webhook.dead_letter", { delivery_id: row.id, webhook_event: row.event, attempts: MAX_ATTEMPTS });
}

export type WebhookHealth = {
  /**
   * **이 프로세스가** 포기한 배달 수(누적). replica 가 여럿이면 전체가 아니다 —
   * 클러스터 합계는 `/api/internal/metrics` 의 `shared` 쪽에서 본다.
   */
  scope: "process";
  deadLetters: number;
  lastDeadLetterAt: string | null;
  lastDeadLetterId: string | null;
  lastDeadLetterEvent: string | null;
};

export function getWebhookHealth(): WebhookHealth {
  return {
    scope: "process",
    deadLetters: deadLetter.total,
    lastDeadLetterAt: deadLetter.lastAt === null ? null : new Date(deadLetter.lastAt).toISOString(),
    lastDeadLetterId: deadLetter.lastId,
    lastDeadLetterEvent: deadLetter.lastEvent,
  };
}

export function resetWebhookHealth(): void {
  deadLetter.total = 0;
  deadLetter.lastAt = null;
  deadLetter.lastId = null;
  deadLetter.lastEvent = null;
}

export type SweepResult = { retried: number; skipped: number; dead: number };

async function deliverAll(db: Db, rows: Candidate[], deadline: number): Promise<SweepResult> {
  let retried = 0;
  let skipped = 0;
  let dead = 0;
  // 동시성 제한은 `mapLimit` 하나로 통일한다 — 같은 루프를 파일마다 새로 쓰면 한 곳만 고쳐진다.
  // 결과 배열은 쓰지 않는다(집계는 클로저로 센다).
  await mapLimit(rows, SWEEP_CONCURRENCY, async (row) => {
    // 예산을 넘겼으면 **클레임하지 않는다** — 클레임만 하고 못 보내면 시도 하나가 헛돈다
    if (Date.now() >= deadline) {
      skipped += 1;
      return;
    }
    try {
      const r = await claimAndDeliver(db, row);
      if (r.claimed) retried += 1;
      else skipped += 1;
      if (r.dead) dead += 1;
    } catch (e) {
      skipped += 1;
      log.warn("webhook.retry_failed", { delivery_id: row.id, webhook_event: row.event, reason: errorMessage(e) });
    }
  });
  return { retried, skipped, dead };
}

/** 실패 웹훅 재시도 — **프로젝트 스코프** + 원자적 클레임(중복 재전송 방지). */
export async function retryWebhooks(projectId: string, limit = 100): Promise<SweepResult> {
  const db = getDb();
  const rows = await candidates(db, and(eq(webhooks.projectId, projectId)), limit);
  return deliverAll(db, rows, Date.now() + SWEEP_BUDGET_MS);
}

/**
 * 전 프로젝트 재시도 스윕 — 워커가 주기적으로 한 번만 부른다(프로젝트 수만큼 호출하지 않게).
 * 여러 워커가 동시에 돌아도 안전하다: 행 단위 CAS 클레임으로 한 명만 가져간다.
 *
 * 백오프가 찬 실패분과 함께 **버려진 `pending`**(삽입 직후 프로세스가 죽어 아무도 손대지 않은 행)도
 * 회수한다. `dead` 는 이번 스윕에서 시도를 다 쓰고 포기한 건수다.
 */
export async function sweepWebhookRetries(
  opts: { limit?: number; budgetMs?: number } = {}
): Promise<SweepResult & { candidates: number }> {
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
