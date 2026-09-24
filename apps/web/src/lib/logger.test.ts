import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { countEvent, getLogCounters, log, logEvent, logThrottled, resetLogCounters } from "./logger";

/** 실제로 찍힌 줄을 잡아 둔다 — 로거의 계약은 "한 줄 JSON" 이다. */
function captureLines() {
  const lines: string[] = [];
  const take = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(take as never);
  vi.spyOn(process.stderr, "write").mockImplementation(take as never);
  return {
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("logger", () => {
  const savedLevel = process.env.NOTIKIT_LOG_LEVEL;

  beforeEach(() => {
    resetLogCounters();
    process.env.NOTIKIT_LOG_LEVEL = "debug"; // 테스트 기본값은 silent 라 명시적으로 연다
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLevel === undefined) delete process.env.NOTIKIT_LOG_LEVEL;
    else process.env.NOTIKIT_LOG_LEVEL = savedLevel;
  });

  it("emits one JSON line with the level, event and fields", () => {
    const cap = captureLines();
    log.warn("webhook.dead_letter", { delivery_id: "d1", webhook_event: "message.sent", attempts: 5 });

    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0].endsWith("\n")).toBe(true);
    expect(cap.parsed()[0]).toMatchObject({
      level: "warn",
      event: "webhook.dead_letter", // 예약 키는 호출부 필드에 덮이지 않는다
      webhook_event: "message.sent",
      delivery_id: "d1",
      attempts: 5,
    });
  });

  // 조용한 실패를 세려고 만든 로그가 정작 토큰을 흘리면 안 된다.
  // 호출부의 주의력이 아니라 **키 이름**으로 막는다.
  it("never writes secrets, tokens, phone numbers or emails", () => {
    const cap = captureLines();
    log.info("push.sent", {
      project_id: "p1",
      token: "fcm-token-abc",
      api_key: "nk_live_123",
      phone: "010-1234-5678",
      email: "a@b.com",
      identity_hash: "deadbeef",
      count: 3,
    });

    const line = cap.lines[0];
    for (const leak of ["fcm-token-abc", "nk_live_123", "010-1234-5678", "a@b.com", "deadbeef"]) {
      expect(line).not.toContain(leak);
    }
    expect(cap.parsed()[0]).toMatchObject({ project_id: "p1", count: 3 });
  });

  it("truncates long free text so one exception cannot own the line", () => {
    const cap = captureLines();
    log.error("worker.tick_failed", { reason: "x".repeat(1_000) });
    expect(String(cap.parsed()[0].reason)).toHaveLength(301); // 300 + 생략 기호
  });

  it("splits counters by reason so quota errors and dead tokens are distinguishable", () => {
    countEvent("push.failed", { reason: "messaging/quota-exceeded" });
    countEvent("push.failed", { reason: "messaging/quota-exceeded" });
    countEvent("push.failed", { reason: "registration-token-not-registered" });

    const counters = getLogCounters();
    expect(counters.scope).toBe("process"); // replica 의 조각임을 노출 지점이 알 수 있게
    expect(counters.events["push.failed"]).toBe(3);
    expect(counters.reasons["push.failed"]).toEqual({
      "messaging/quota-exceeded": 2,
      "registration-token-not-registered": 1,
    });
  });

  it("keeps counting while it throttles the log line", () => {
    const cap = captureLines();
    for (let i = 0; i < 5; i++) logThrottled("warn", "redis.fallback", { reason: "no connection" });

    // 줄은 1개지만 카운터는 5 — 로그를 묶었다고 장애가 사라지면 안 된다
    expect(cap.lines).toHaveLength(1);
    expect(getLogCounters().events["redis.fallback"]).toBe(5);

    // 다음 창에서는 그동안 눌린 횟수를 함께 남긴다
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    logThrottled("warn", "redis.fallback", { reason: "no connection" });
    vi.useRealTimers();
    expect(cap.parsed()[1]).toMatchObject({ suppressed: 4 });
  });

  it("counts even when the level suppresses the line", () => {
    process.env.NOTIKIT_LOG_LEVEL = "error";
    const cap = captureLines();
    logEvent("info", "redis.recovered");
    expect(cap.lines).toHaveLength(0);
    expect(getLogCounters().events["redis.recovered"]).toBe(1);
  });
});
