import { describe, it, expect, afterEach, beforeEach } from "vitest";
import net from "node:net";
import {
  encodeCommand,
  getRedisHealth,
  parseReply,
  parseRedisUrl,
  redisIncrementWindow,
  resetRedis,
  resetRedisHealth,
} from "./redis";

describe("redis RESP", () => {
  it("encodes commands as RESP arrays of bulk strings", () => {
    expect(encodeCommand(["INCR", "nk:rl:a:1"]).toString()).toBe("*2\r\n$4\r\nINCR\r\n$9\r\nnk:rl:a:1\r\n");
  });

  it("encodes multi-byte arguments by byte length, not character count", () => {
    const encoded = encodeCommand(["SET", "키"]).toString();
    expect(encoded).toContain("$3\r\n키\r\n"); // 문자 1개지만 UTF-8 3바이트
  });

  it("parses integer, simple string and error replies", () => {
    expect(parseReply(Buffer.from(":42\r\n"))).toEqual({ value: 42, next: 5 });
    expect(parseReply(Buffer.from("+OK\r\n"))).toEqual({ value: "OK", next: 5 });
    expect(parseReply(Buffer.from("-ERR nope\r\n"))?.error).toBe("ERR nope");
  });

  it("parses bulk strings and null bulk", () => {
    expect(parseReply(Buffer.from("$3\r\nabc\r\n"))?.value).toBe("abc");
    expect(parseReply(Buffer.from("$-1\r\n"))?.value).toBeNull();
  });

  it("parses nested arrays", () => {
    expect(parseReply(Buffer.from("*2\r\n:1\r\n$2\r\nhi\r\n"))?.value).toEqual([1, "hi"]);
  });

  it("returns null while the reply is still incomplete", () => {
    expect(parseReply(Buffer.from("$5\r\nab"))).toBeNull();
    expect(parseReply(Buffer.from("*2\r\n:1\r\n"))).toBeNull();
    expect(parseReply(Buffer.from(":4"))).toBeNull();
  });

  it("reports the offset so a pipelined stream can be drained", () => {
    const stream = Buffer.from(":7\r\n+OK\r\n");
    const first = parseReply(stream, 0);
    expect(first?.value).toBe(7);
    expect(parseReply(stream, first!.next)?.value).toBe("OK");
  });
});

describe("parseRedisUrl", () => {
  it("defaults host/port and rejects other schemes", () => {
    expect(parseRedisUrl("redis://localhost")).toMatchObject({ host: "localhost", port: 6379, tls: false });
    expect(parseRedisUrl("http://localhost:6379")).toBeNull();
    expect(parseRedisUrl("not a url")).toBeNull();
  });

  it("reads credentials, db index and TLS", () => {
    expect(parseRedisUrl("rediss://user:p%40ss@cache.example.com:6380/3")).toEqual({
      host: "cache.example.com",
      port: 6380,
      tls: true,
      username: "user",
      password: "p@ss",
      db: 3,
    });
  });
});

// ── 연결 상태 기계 — 진짜 소켓 위에서 (net.createServer, 외부 의존성 없음) ──

/** 클라이언트가 보낸 RESP 명령 하나를 떼어 낸다. 덜 왔으면 null. */
function takeCommand(buf: string): { cmd: string[]; rest: string } | null {
  if (!buf.startsWith("*")) return null;
  const head = buf.indexOf("\r\n");
  if (head === -1) return null;
  const count = Number(buf.slice(1, head));
  let cursor = head + 2;
  const cmd: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf[cursor] !== "$") return null;
    const lineEnd = buf.indexOf("\r\n", cursor);
    if (lineEnd === -1) return null;
    const len = Number(buf.slice(cursor + 1, lineEnd));
    const start = lineEnd + 2;
    if (buf.length < start + len + 2) return null;
    cmd.push(buf.slice(start, start + len));
    cursor = start + len + 2;
  }
  return { cmd, rest: buf.slice(cursor) };
}

type FakeRedis = {
  port: number;
  /** 지금까지 받은 명령 (이름만) */
  seen: string[][];
  /** 서버가 먼저 연결을 끊는다 — 'close' 경로 검증용 */
  dropConnections: () => void;
  stop: () => Promise<void>;
};

type FakeOpts = {
  /** true 면 어떤 명령에도 답하지 않는다 */
  mute?: boolean;
  /** 이 순번(0-based)까지의 명령 응답을 지연시킨다 — 응답 순서는 유지한다 */
  delayFirst?: number;
  delayMs?: number;
};

async function startFakeRedis(opts: FakeOpts = {}): Promise<FakeRedis> {
  const counters = new Map<string, number>();
  const seen: string[][] = [];
  const live = new Set<net.Socket>();
  let handled = 0;

  const server = net.createServer((socket) => {
    live.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => live.delete(socket));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const taken = takeCommand(buf);
        if (!taken) break;
        buf = taken.rest;
        seen.push(taken.cmd);
        if (opts.mute) continue;

        const [name, key] = taken.cmd;
        let reply = "+OK\r\n";
        if (name === "INCR") {
          const n = (counters.get(key) ?? 0) + 1;
          counters.set(key, n);
          reply = `:${n}\r\n`;
        } else if (name === "PEXPIRE") {
          reply = ":1\r\n";
        }
        // 응답 순서는 언제나 요청 순서와 같다 — 지연도 순서를 바꾸지 않는다
        const nth = handled++;
        if (opts.delayFirst !== undefined && nth <= opts.delayFirst) {
          setTimeout(() => socket.write(reply), opts.delayMs ?? 1_300);
        } else {
          socket.write(reply);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    seen,
    dropConnections: () => {
      for (const s of live) s.destroy();
      live.clear();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy();
        live.clear();
        server.close(() => resolve());
      }),
  };
}

describe("redis connection state machine", () => {
  const savedUrl = process.env.REDIS_URL;
  const savedCooldown = process.env.REDIS_RECONNECT_COOLDOWN_MS;
  let fake: FakeRedis | null = null;

  const use = async (opts?: FakeOpts) => {
    fake = await startFakeRedis(opts);
    process.env.REDIS_URL = `redis://127.0.0.1:${fake.port}`;
    resetRedis(); // env 재해석
    return fake;
  };

  const savedProbe = process.env.REDIS_DEGRADED_PROBE_MS;

  beforeEach(() => {
    process.env.REDIS_RECONNECT_COOLDOWN_MS = "0"; // 테스트에서 5초를 기다리지 않는다
    resetRedisHealth();
  });

  afterEach(async () => {
    resetRedis();
    await fake?.stop();
    fake = null;
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
    if (savedCooldown === undefined) delete process.env.REDIS_RECONNECT_COOLDOWN_MS;
    else process.env.REDIS_RECONNECT_COOLDOWN_MS = savedCooldown;
    if (savedProbe === undefined) delete process.env.REDIS_DEGRADED_PROBE_MS;
    else process.env.REDIS_DEGRADED_PROBE_MS = savedProbe;
  });

  it("pairs each reply with its own command", async () => {
    const server = await use();
    expect(await redisIncrementWindow("nk:rl:a:1", 60_000)).toBe(1);
    expect(await redisIncrementWindow("nk:rl:a:1", 60_000)).toBe(2);
    expect(await redisIncrementWindow("nk:rl:b:1", 60_000)).toBe(1); // 키마다 따로 센다

    // INCR 의 짝은 INCR 응답이다 — PEXPIRE 의 +OK/:1 이 섞여 들어오지 않는다
    expect(server.seen.map((c) => c[0])).toEqual(["INCR", "PEXPIRE", "INCR", "PEXPIRE", "INCR", "PEXPIRE"]);
    expect(getRedisHealth()).toMatchObject({ connected: true, fallbacks: 0 });
  });

  it("pipelines INCR and PEXPIRE on one round trip with the window TTL", async () => {
    const server = await use();
    await redisIncrementWindow("nk:rl:k:7", 65_000);
    expect(server.seen[0]).toEqual(["INCR", "nk:rl:k:7"]);
    expect(server.seen[1]).toEqual(["PEXPIRE", "nk:rl:k:7", "65000"]);
  });

  it("falls back within the caller's budget instead of blocking the request", async () => {
    await use({ mute: true });
    const started = Date.now();
    expect(await redisIncrementWindow("nk:rl:slow:1", 60_000, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500); // 명령 타임아웃(1s)을 기다리지 않는다
    expect(getRedisHealth().fallbacks).toBe(1);
  });

  it("keeps a healthy connection after one slow command and still pairs the next reply", async () => {
    const server = await use({ delayFirst: 1, delayMs: 1_200 }); // 첫 INCR/PEXPIRE 쌍만 늦게 답한다

    // 예산을 넘겨 폴백한다. 응답이 오지 않은 자리는 대기열에 남아 순서를 지킨다.
    expect(await redisIncrementWindow("nk:rl:late:1", 60_000, 100)).toBeNull();
    expect(getRedisHealth().connected).toBe(true); // 느린 명령 하나로 연결을 버리지 않는다

    // 늦은 응답(:1, +OK)이 도착해 버려진 자리를 소비한 뒤에도 다음 명령은 자기 응답을 받는다
    await new Promise((r) => setTimeout(r, 1_400));
    expect(await redisIncrementWindow("nk:rl:late:1", 60_000)).toBe(2);
    expect(server.seen.length).toBe(4);
    expect(getRedisHealth().connected).toBe(true);
  }, 10_000);

  it("tears the connection down once timeouts pile up", async () => {
    await use({ mute: true });
    // 명령 6개(=INCR/PEXPIRE 3쌍)가 모두 타임아웃하면 지연이 아니라 죽은 연결로 본다
    const results = await Promise.all([
      redisIncrementWindow("nk:rl:dead:1", 60_000),
      redisIncrementWindow("nk:rl:dead:2", 60_000),
      redisIncrementWindow("nk:rl:dead:3", 60_000),
    ]);
    expect(results).toEqual([null, null, null]);
    const h = getRedisHealth();
    expect(h.connected).toBe(false);
    expect(h.timeouts).toBeGreaterThanOrEqual(5);
    expect(h.fallbacks).toBe(3);
    expect(h.degradedSince).not.toBeNull();
  }, 10_000);

  it("reconnects after the server drops the connection", async () => {
    const server = await use();
    expect(await redisIncrementWindow("nk:rl:rc:1", 60_000)).toBe(1);

    server.dropConnections();
    await new Promise((r) => setTimeout(r, 50)); // 'close' 가 teardown 을 돌게 둔다
    expect(getRedisHealth().connected).toBe(false);

    // 쿨다운이 지나면 다음 호출이 새 연결을 연다 — 카운터는 서버에 남아 있으므로 이어진다
    expect(await redisIncrementWindow("nk:rl:rc:1", 60_000)).toBe(2);
    expect(getRedisHealth().connected).toBe(true);
  });

  it("respects the reconnect cooldown instead of dialing on every request", async () => {
    process.env.REDIS_RECONNECT_COOLDOWN_MS = "10000";
    const server = await use();
    expect(await redisIncrementWindow("nk:rl:cd:1", 60_000)).toBe(1);

    server.dropConnections();
    await new Promise((r) => setTimeout(r, 50));
    expect(await redisIncrementWindow("nk:rl:cd:1", 60_000)).toBeNull(); // 쿨다운 중 — 재연결하지 않는다
    expect(getRedisHealth().cooldownMs).toBeGreaterThan(0);
  });

  /**
   * 회귀: 예산이 **연결 대기**를 덮지 않으면, Redis 가 처음 느려지는 순간 모든 동시 요청이
   * 같은 `ready` 를 연결 타임아웃(2초)까지 함께 기다린다. 호출자가 약속한 예산이 무의미해지고,
   * in-flight 슬롯을 쥔 채 기다리는 라우트(로그인)는 인증과 무관하게 503 을 돌려준다.
   *
   * 연결이 매달리는 상황은 TLS 로 만든다 — 평문 서버에 rediss:// 로 붙으면 ClientHello 에
   * 아무도 답하지 않아 `secureConnect` 가 영영 오지 않는다(외부 의존성 없이 재현된다).
   */
  it("counts the connect wait against the caller's budget", async () => {
    fake = await startFakeRedis();
    process.env.REDIS_URL = `rediss://127.0.0.1:${fake.port}`; // 핸드셰이크에 답하지 않는다
    resetRedis();

    const started = Date.now();
    const results = await Promise.all([
      redisIncrementWindow("nk:rl:cx:1", 60_000, 60),
      redisIncrementWindow("nk:rl:cx:2", 60_000, 60),
      redisIncrementWindow("nk:rl:cx:3", 60_000, 60),
    ]);
    const elapsed = Date.now() - started;

    expect(results).toEqual([null, null, null]);
    // 고치기 전에는 세 요청 모두 CONNECT_TIMEOUT_MS(2초)를 기다렸다
    expect(elapsed).toBeLessThan(600);
    expect(getRedisHealth().fallbacks).toBe(3);
  }, 10_000);

  /**
   * "살아 있지만 느린" Redis — 연결은 멀쩡하니 재연결 쿨다운이 걸리지 않고, 예산만 매 요청
   * 꽉 채워 문다. 차단기가 열리면 그 구간에서는 **묻지도 않는다**(예산 0).
   */
  it("stops paying the budget while redis is slow, then re-probes", async () => {
    process.env.REDIS_DEGRADED_PROBE_MS = "300";
    await use({ mute: true }); // 붙긴 붙지만 아무 명령에도 답하지 않는다

    for (let i = 0; i < 3; i++) {
      expect(await redisIncrementWindow("nk:rl:slow:1", 60_000, 40)).toBeNull();
    }
    expect(getRedisHealth().breakerMs).toBeGreaterThan(0); // 연속 예산 초과 3회 → 차단

    const blocked = Date.now();
    expect(await redisIncrementWindow("nk:rl:slow:1", 60_000, 40)).toBeNull();
    expect(Date.now() - blocked).toBeLessThan(20); // 예산을 물지 않았다
    expect(getRedisHealth().shortCircuits).toBe(1);

    // 창이 지나면 한 요청만 통과시켜 회복을 확인한다 — 여전히 느리면 창이 다시 열린다
    await new Promise((r) => setTimeout(r, 340));
    const probed = Date.now();
    expect(await redisIncrementWindow("nk:rl:slow:1", 60_000, 40)).toBeNull();
    expect(Date.now() - probed).toBeGreaterThanOrEqual(30);
    expect(getRedisHealth().breakerMs).toBeGreaterThan(0);
  }, 10_000);

  it("closes the breaker once a probe answers inside the budget", async () => {
    process.env.REDIS_DEGRADED_PROBE_MS = "600";
    // 앞의 3쌍(=6개 명령)만 늦게 답한다 — 그 뒤로는 즉시 답하는 건강한 서버다
    await use({ delayFirst: 5, delayMs: 250 });

    for (let i = 0; i < 3; i++) {
      expect(await redisIncrementWindow("nk:rl:heal:1", 60_000, 40)).toBeNull();
    }
    expect(getRedisHealth().breakerMs).toBeGreaterThan(0);

    // 늦은 응답이 도착해도 **그것만으로는 회복이 아니다** — 예산을 넘겨 도착한 답을 회복으로
    // 치면 느린 Redis 에서 차단기가 매번 리셋되어 영영 열리지 않는다.
    await new Promise((r) => setTimeout(r, 250));
    expect(getRedisHealth().commands).toBeGreaterThan(0); // 응답은 짝지어졌다
    expect(getRedisHealth().breakerMs).toBeGreaterThan(0); // 그래도 차단은 유지
    expect(getRedisHealth().degradedSince).not.toBeNull();

    // 창이 지난 뒤의 probe 는 예산 안에 답을 받는다 → 차단 해제 + 공유 카운트가 이어진다
    await new Promise((r) => setTimeout(r, 450));
    expect(await redisIncrementWindow("nk:rl:heal:1", 60_000, 500)).toBe(4);
    expect(getRedisHealth().breakerMs).toBe(0);
    expect(await redisIncrementWindow("nk:rl:heal:1", 60_000, 500)).toBe(5);
  }, 10_000);

  it("stays disabled when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    resetRedis();
    expect(await redisIncrementWindow("nk:rl:none:1", 60_000)).toBeNull();
    expect(getRedisHealth()).toMatchObject({ enabled: false, connected: false });
  });
});
