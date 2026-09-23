import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 공유 경로는 Redis 를 대역으로 세워 **판정 규칙**만 본다.
// 소켓/RESP 동작은 redis.test.ts 가 진짜 서버로 따로 검증한다.
const redisMock = vi.hoisted(() => ({
  enabled: false,
  incr: vi.fn<(key: string, ttlMs: number, budgetMs?: number) => Promise<number | null>>(),
}));

vi.mock("@/lib/redis", () => ({
  isRedisEnabled: () => redisMock.enabled,
  redisIncrementWindow: redisMock.incr,
  getRedisHealth: () => ({
    enabled: redisMock.enabled,
    connected: redisMock.enabled,
    cooldownMs: 0,
    commands: 0,
    timeouts: 0,
    fallbacks: 0,
    degradedSince: null,
    lastError: null,
    lastErrorAt: null,
  }),
}));

import {
  clientKey,
  decideFixedWindow,
  principalKey,
  rateLimit,
  rateLimitShared,
  resetRateLimits,
  sharedWindowKey,
  windowResetAt,
} from "./rate-limit";

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

describe("principalKey", () => {
  it("adds a device/user dimension so one abuser cannot 429 the whole tenant", () => {
    expect(principalKey("p1", "click", "tok-a")).not.toBe(principalKey("p1", "click", "tok-b"));
    expect(principalKey("p1", "click", "tok-a")).not.toBe(principalKey("p2", "click", "tok-a"));
    expect(principalKey("p1", "click", "tok-a")).not.toBe(principalKey("p1", "events", "tok-a"));
    expect(principalKey("p1", "click", "tok-a")).toBe(principalKey("p1", "click", "tok-a")); // 안정적
  });

  it("hashes the principal to a fixed length and never echoes the raw token", () => {
    const key = principalKey("p1", "click", "super-secret-push-token");
    expect(key).not.toContain("super-secret-push-token");
    expect(key).toMatch(/^proj:p1:click:p:[0-9a-f]{16}$/);
    expect(principalKey("p1", "click", "x".repeat(4096)).length).toBe(key.length);
  });
});

describe("rateLimitShared (Redis is authoritative)", () => {
  beforeEach(() => {
    resetRateLimits();
    redisMock.enabled = true;
    redisMock.incr.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    redisMock.enabled = false;
  });

  it("denies on the global count even when this replica has seen nothing", async () => {
    // 다른 replica 들이 이미 한도를 채웠다 — 로컬 버킷은 비어 있어도 거절해야 한다
    redisMock.incr.mockResolvedValue(11);
    expect(await rateLimitShared("k", 10, 60_000)).toBe(false);
  });

  it("allows exactly up to the limit as the shared counter climbs", async () => {
    for (const shared of [1, 2, 3]) {
      redisMock.incr.mockResolvedValueOnce(shared);
      expect(await rateLimitShared("k", 3, 60_000)).toBe(true);
    }
    redisMock.incr.mockResolvedValueOnce(4);
    expect(await rateLimitShared("k", 3, 60_000)).toBe(false);
  });

  it("waits for the INCR — the decision is never made before the reply", async () => {
    let release!: (n: number) => void;
    redisMock.incr.mockReturnValueOnce(new Promise<number>((r) => { release = r; }));
    let decided: boolean | null = null;
    const pending = rateLimitShared("k", 10, 60_000).then((v) => (decided = v));
    await Promise.resolve();
    expect(decided).toBeNull(); // 아직 판정하지 않았다
    release(99);
    await pending;
    expect(decided).toBe(false);
  });

  it("counts against an epoch-aligned window key with a TTL past the window", async () => {
    redisMock.incr.mockResolvedValue(1);
    await rateLimitShared("proj:p1:events", 10, 60_000);
    const [key, ttl, budget] = redisMock.incr.mock.calls[0];
    expect(key).toBe(sharedWindowKey("proj:p1:events", Date.now(), 60_000));
    expect(ttl).toBeGreaterThan(60_000);
    expect(budget).toBeGreaterThan(0); // 요청이 무한정 기다리지 않게 예산이 걸려 있다
  });

  it("falls back to local counting only when Redis is genuinely unavailable", async () => {
    redisMock.incr.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) expect(await rateLimitShared("k", 3, 60_000)).toBe(true);
    expect(await rateLimitShared("k", 3, 60_000)).toBe(false);
  });

  it("resumes the fallback from the last known global count, not from zero", async () => {
    redisMock.incr.mockResolvedValueOnce(9); // 전역으로 이미 9번 — 이 replica 는 처음 본다
    expect(await rateLimitShared("k", 10, 60_000)).toBe(true);

    redisMock.incr.mockResolvedValue(null); // Redis 다운
    expect(await rateLimitShared("k", 10, 60_000)).toBe(true); // 10번째
    expect(await rateLimitShared("k", 10, 60_000)).toBe(false); // 11번째 — 0 부터 다시 세지 않는다
  });

  it("recovers once the window rolls over", async () => {
    redisMock.incr.mockResolvedValueOnce(5);
    expect(await rateLimitShared("k", 3, 60_000)).toBe(false);
    vi.advanceTimersByTime(60_000);
    redisMock.incr.mockResolvedValueOnce(1);
    expect(await rateLimitShared("k", 3, 60_000)).toBe(true);
  });

  it("counts in memory when REDIS_URL is not configured at all", async () => {
    redisMock.enabled = false;
    for (let i = 0; i < 2; i++) expect(await rateLimitShared("k", 2, 60_000)).toBe(true);
    expect(await rateLimitShared("k", 2, 60_000)).toBe(false);
    expect(redisMock.incr).not.toHaveBeenCalled();
  });
});
