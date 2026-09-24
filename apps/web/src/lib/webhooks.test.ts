import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { webhookDeliveries, webhooks } from "@/db/schema";
import {
  MAX_ATTEMPTS,
  getWebhookHealth,
  isRetryEligible,
  resetWebhookHealth,
  retryDelayMs,
  retryEligibleAt,
  retryFilter,
  stalePendingFilter,
} from "./webhooks";

const MIN = 60_000;
const failedAt = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => failedAt.getTime() + ms;

describe("webhook retry backoff", () => {
  it("backs off 1m, 5m, 25m, 125m between attempts", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1 * MIN, 5 * MIN, 25 * MIN, 125 * MIN]);
  });

  it("schedules the next attempt from the failure time, not from creation", () => {
    // 기준이 직전 실패라 워커가 멈췄다 떠도 남은 시도를 한꺼번에 태우지 않는다
    expect(retryEligibleAt(failedAt, 1).getTime()).toBe(at(1 * MIN));
    expect(retryEligibleAt(failedAt, 2).getTime()).toBe(at(5 * MIN));
    expect(retryEligibleAt(failedAt, 3).getTime()).toBe(at(25 * MIN));
    expect(retryEligibleAt(failedAt, 4).getTime()).toBe(at(125 * MIN));
  });

  it("holds a delivery until its window opens", () => {
    const due = retryEligibleAt(failedAt, 1);
    expect(isRetryEligible(due, 1, at(1 * MIN - 1))).toBe(false);
    expect(isRetryEligible(due, 1, at(1 * MIN))).toBe(true);
  });

  it("treats rows predating the column (NULL) as due now", () => {
    expect(isRetryEligible(null, 1, at(0))).toBe(true);
  });

  it("gives up after MAX_ATTEMPTS no matter how much time passed", () => {
    const longAgo = new Date(at(-365 * 24 * 60 * MIN));
    expect(isRetryEligible(longAgo, MAX_ATTEMPTS - 1)).toBe(true);
    expect(isRetryEligible(longAgo, MAX_ATTEMPTS)).toBe(false);
    expect(isRetryEligible(null, MAX_ATTEMPTS)).toBe(false);
  });

  it("acts as a lease: claiming pushes the window out by the next backoff", () => {
    // 클레임이 attempts 를 올리고 next_attempt_at 을 밀어 둔다 → 죽은 워커가 남긴 `retrying` 행도
    // 그 창이 지나야 회수되고, 그 전에는 다른 워커가 같은 건을 다시 쏘지 않는다
    const leaseUntil = retryEligibleAt(failedAt, 2);
    expect(isRetryEligible(leaseUntil, 2, at(5 * MIN - 1))).toBe(false);
    expect(isRetryEligible(leaseUntil, 2, at(5 * MIN))).toBe(true);
  });
});

// ── 스윕 후보 질의 — 실제 DB 없이 생성된 SQL 을 본다 ──
// postgres-js 는 쿼리를 보낼 때만 접속하므로 toSQL() 만 쓰는 한 연결이 열리지 않는다.
const db = drizzle(postgres("postgres://u:p@127.0.0.1:1/none", { max: 1 }));

function compile(filter: ReturnType<typeof retryFilter>) {
  return db
    .select()
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(filter)
    .toSQL();
}

describe("sweep candidates", () => {
  it("keeps the retry status set identical to the 0025 partial index predicate", () => {
    // 인덱스: (next_attempt_at, attempts) where status in ('failed','retrying')
    const { sql, params } = compile(retryFilter());
    expect(sql).toContain(`"webhook_deliveries"."status" in (`);
    expect(params.filter((p) => p === "failed" || p === "retrying")).toEqual(["failed", "retrying"]);
    expect(params).not.toContain("delivered"); // 집합이 넓어지면 인덱스를 놓친다
    expect(sql).toContain("next_attempt_at is null or webhook_deliveries.next_attempt_at <= now()");
  });

  it("picks up orphaned pending rows through a separate age cutoff", () => {
    // emitWebhook 삽입 직후 죽으면 행이 pending 으로 남는다 — 재시도 질의는 이 상태를 보지 않는다
    const now = new Date("2026-03-01T00:05:00Z");
    const { sql, params } = compile(stalePendingFilter(now));
    expect(params).toContain("pending");
    expect(sql).toContain(`"webhook_deliveries"."created_at" < `);

    // 컷오프는 지금이 아니라 충분히 지난 시점 — 지금 날아가는 중인 건을 두 번 보내지 않는다
    const cutoff = new Date(params.at(-1) as string);
    expect(cutoff.getTime()).toBeLessThan(now.getTime());
    expect(now.getTime() - cutoff.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  it("excludes inactive webhooks and exhausted deliveries in both queries", () => {
    for (const filter of [retryFilter(), stalePendingFilter(new Date())]) {
      const { sql, params } = compile(filter);
      expect(sql).toContain(`"webhooks"."is_active" = `);
      expect(sql).toContain(`"webhook_deliveries"."attempts" < `);
      expect(params).toContain(MAX_ATTEMPTS);
    }
  });
});

describe("webhook health", () => {
  it("starts clean and reports no dead letters", () => {
    resetWebhookHealth();
    expect(getWebhookHealth()).toEqual({
      scope: "process", // replica 가 여럿이면 이 숫자는 인스턴스의 조각이다
      deadLetters: 0,
      lastDeadLetterAt: null,
      lastDeadLetterId: null,
      lastDeadLetterEvent: null,
    });
  });
});
