import { describe, it, expect } from "vitest";
import { MAX_ATTEMPTS, isRetryEligible, retryDelayMs, retryEligibleAt } from "./webhooks";

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
