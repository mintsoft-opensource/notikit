import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clientKey, decideFixedWindow, rateLimit, resetRateLimits, sharedWindowKey, windowResetAt } from "./rate-limit";

// 판정 로직만 검증한다 — 저장소(Map)나 전송(Redis)은 끼지 않는다.
describe("decideFixedWindow", () => {
  const WINDOW = 60_000;

  it("starts a window on the first hit", () => {
    const { allowed, bucket } = decideFixedWindow(undefined, 1_000, 3, WINDOW);
    expect(allowed).toBe(true);
    expect(bucket).toEqual({ count: 1, resetAt: 61_000 });
  });

  it("counts up to the limit and then denies", () => {
    let bucket = decideFixedWindow(undefined, 0, 3, WINDOW).bucket;
    for (const expected of [2, 3]) {
      const r = decideFixedWindow(bucket, 10, 3, WINDOW);
      expect(r.allowed).toBe(true);
      expect(r.bucket.count).toBe(expected);
      bucket = r.bucket;
    }
    const denied = decideFixedWindow(bucket, 20, 3, WINDOW);
    expect(denied.allowed).toBe(false);
    expect(denied.bucket.count).toBe(3); // 거절은 카운트를 올리지 않는다
  });

  it("does not mutate the previous bucket", () => {
    const prev = { count: 1, resetAt: 60_000 };
    decideFixedWindow(prev, 10, 3, WINDOW);
    expect(prev.count).toBe(1);
  });

  it("resets only once the window has passed", () => {
    const prev = { count: 9, resetAt: 60_000 };
    expect(decideFixedWindow(prev, 60_000, 3, WINDOW).allowed).toBe(false); // 경계는 아직 같은 창
    const after = decideFixedWindow(prev, 60_001, 3, WINDOW);
    expect(after.allowed).toBe(true);
    expect(after.bucket.count).toBe(1);
  });

  it("aligns windows to the epoch in shared mode so replicas agree", () => {
    expect(windowResetAt(90_000, 60_000, false)).toBe(150_000);
    expect(windowResetAt(90_000, 60_000, true)).toBe(120_000);
    expect(decideFixedWindow(undefined, 90_000, 3, WINDOW, true).bucket.resetAt).toBe(120_000);
  });
});

describe("sharedWindowKey", () => {
  it("puts the window number in the key so Redis TTL can expire it", () => {
    expect(sharedWindowKey("proj:p1:send", 125_000, 60_000)).toBe("nk:rl:proj:p1:send:2");
    expect(sharedWindowKey("proj:p1:send", 179_999, 60_000)).toBe("nk:rl:proj:p1:send:2");
    expect(sharedWindowKey("proj:p1:send", 180_000, 60_000)).toBe("nk:rl:proj:p1:send:3");
  });
});

describe("rateLimit (in-memory fallback)", () => {
  const savedUrl = process.env.REDIS_URL;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  });

  it("allows up to the limit and then refuses", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000)).toBe(true);
    expect(rateLimit("k", 3, 60_000)).toBe(false);
  });

  it("keeps keys independent", () => {
    expect(rateLimit("a", 1, 60_000)).toBe(true);
    expect(rateLimit("a", 1, 60_000)).toBe(false);
    expect(rateLimit("b", 1, 60_000)).toBe(true);
  });

  it("recovers once the window elapses", () => {
    expect(rateLimit("k", 1, 60_000)).toBe(true);
    expect(rateLimit("k", 1, 60_000)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rateLimit("k", 1, 60_000)).toBe(true);
  });
});

describe("clientKey", () => {
  it("scopes per project and route so one route cannot starve another", () => {
    expect(clientKey("p1", "send")).toBe("proj:p1:send");
    expect(clientKey("p1")).toBe("proj:p1:default");
    expect(clientKey("p1", "click")).not.toBe(clientKey("p1", "send"));
  });
});
