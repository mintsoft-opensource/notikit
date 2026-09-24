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
  getRateLimitHealth,
  MAX_BUCKETS,
  principalKey,
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
    // 창은 언제나 epoch 정렬 — 1_000 이 속한 창은 [0, 60_000)
    expect(bucket).toEqual({ count: 1, resetAt: 60_000 });
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

  // 인스턴스마다 창 시작이 다르면 같은 Redis 키를 두고 판정이 엇갈린다 — 언제나 epoch 정렬.
  it("always aligns windows to the epoch so replicas agree", () => {
    expect(windowResetAt(90_000, 60_000)).toBe(120_000);
    expect(windowResetAt(119_999, 60_000)).toBe(120_000);
    expect(decideFixedWindow(undefined, 90_000, 3, WINDOW).bucket.resetAt).toBe(120_000);
  });
});

describe("sharedWindowKey", () => {
  it("puts the window number in the key so Redis TTL can expire it", () => {
    expect(sharedWindowKey("proj:p1:send", 125_000, 60_000)).toBe("nk:rl:proj:p1:send:2");
    expect(sharedWindowKey("proj:p1:send", 179_999, 60_000)).toBe("nk:rl:proj:p1:send:2");
    expect(sharedWindowKey("proj:p1:send", 180_000, 60_000)).toBe("nk:rl:proj:p1:send:3");
  });
});

// REDIS_URL 이 없을 때의 경로 — 유일한 입구인 rateLimitShared 가 로컬 버킷으로 판정한다.
// (레거시 동기 입구 rateLimit() 은 프로덕션 호출부가 사라져 삭제했다.)
describe("rateLimitShared (in-memory fallback)", () => {
  const savedUrl = process.env.REDIS_URL;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    redisMock.enabled = false;
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  });

  it("allows up to the limit and then refuses", async () => {
    for (let i = 0; i < 3; i++) expect(await rateLimitShared("k", 3, 60_000)).toBe(true);
    expect(await rateLimitShared("k", 3, 60_000)).toBe(false);
  });

  it("keeps keys independent", async () => {
    expect(await rateLimitShared("a", 1, 60_000)).toBe(true);
    expect(await rateLimitShared("a", 1, 60_000)).toBe(false);
    expect(await rateLimitShared("b", 1, 60_000)).toBe(true);
  });

  it("recovers once the window elapses", async () => {
    expect(await rateLimitShared("k", 1, 60_000)).toBe(true);
    expect(await rateLimitShared("k", 1, 60_000)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(await rateLimitShared("k", 1, 60_000)).toBe(true);
  });
});

// 저장 상한이 걸린 Map 에서 **무엇을 버리는가**는 곧 한도가 지켜지는가의 문제다.
// 삽입 순서로 버리면 오래 살아 있는(=활성) 버킷이 가장 먼저 나가고, 공격자는
// 그 축출을 스스로 유도해 한도를 0 으로 되돌릴 수 있다.
describe("bucket eviction (memory cap)", () => {
  const savedUrl = process.env.REDIS_URL;
  // 창을 1시간으로 잡아 실제 경과 시간이 창을 넘기지 못하게 한다.
  // (가짜 타이머는 이 규모의 await 루프에서 마이크로태스크마다 비용이 붙어 100배 느려진다)
  const WINDOW = 3_600_000;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    redisMock.enabled = false;
    resetRateLimits();
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  });

  // 재현: 공개 api-key 만 쥔 쪽이 매 요청 새 token 을 보내면 요청마다 principal 버킷이
  // 하나씩 생긴다. 프로젝트 한도(20_000)가 MAX_BUCKETS(10_000)보다 크므로, 한도를
  // 채우기 **전에** 저장소가 먼저 가득 찬다. 프로젝트 버킷은 맨 처음 삽입된 키이고
  // 재삽입해도 순서가 갱신되지 않으므로, 삽입 순서 축출에서는 가장 먼저 사라진다
  // → 카운트가 1 부터 다시 시작하고 한도가 무력화된다.
  it("a fresh-token flood cannot evict the project bucket and reset its limit", async () => {
    const LIMIT = 20_000; // 라우트의 PROJECT_LIMIT_PER_MIN
    const project = clientKey("p1", "events");
    let allowed = 0;
    let blocked = 0;

    for (let i = 0; i < 60_000; i++) {
      if (!(await rateLimitShared(project, LIMIT, WINDOW))) {
        blocked++;
        continue;
      }
      // 라우트와 같은 순서: 프로젝트 → 주체. 주체 키는 매번 새것이라 항상 통과한다.
      await rateLimitShared(principalKey("p1", "events", `tok-${i}`), 30, WINDOW);
      allowed++;
    }

    // 창이 한 번도 넘어가지 않았으므로 통과 수는 정확히 한도여야 한다
    expect(allowed).toBe(LIMIT);
    expect(blocked).toBe(60_000 - LIMIT);
  });

  it("keeps one tenant's flood from wiping another tenant's bucket", async () => {
    const victim = clientKey("victim", "events");
    let victimAllowed = 0;

    for (let i = 0; i < MAX_BUCKETS * 3; i++) {
      await rateLimitShared(principalKey("attacker", "events", `tok-${i}`), 30, WINDOW);
      // 피해 테넌트도 계속 요청을 보내고 있다 — 살아 있는 버킷이다
      if (i % 500 === 0 && (await rateLimitShared(victim, 2, WINDOW))) victimAllowed++;
    }

    // 남의 축출에 기대 한도가 되살아나면 안 된다
    expect(victimAllowed).toBe(2);
  });

  it("still honours the memory cap — idle buckets are the ones that go", async () => {
    for (let i = 0; i < MAX_BUCKETS * 2; i++) {
      await rateLimitShared(principalKey("p1", "events", `tok-${i}`), 30, WINDOW);
    }
    expect(getRateLimitHealth().trackedKeys).toBeLessThanOrEqual(MAX_BUCKETS);
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
