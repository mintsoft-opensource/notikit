/**
 * 최소 Redis(RESP2) 클라이언트 — 공유 rate limit 카운터 전용.
 *
 * 의존성을 늘리지 않으려고 node:net/tls 위에 직접 얹었다. 쓰는 명령은 INCR/PEXPIRE 뿐이라
 * 풀 클라이언트(ioredis)를 들일 이유가 없고, 온프렘 번들 크기도 그대로 둔다.
 *
 * **요청 경로를 막지 않는다**: 연결 실패·타임아웃·오류 응답은 전부 null 로 떨어지고,
 * 호출자(rate-limit)는 인메모리 판정으로 계속 간다. Redis 가 죽었다고 발송 API 가 죽으면 안 된다.
 *
 * 다만 그 폴백은 **조용하면 안 된다**. 인메모리로 떨어지는 순간 한도는 사실상 replica 배수로
 * 느슨해지므로, (a) 폴백 횟수를 세어 `getRedisHealth()` 로 노출하고 (b) 경고를 주기당 1회로
 * 묶되 그동안 눌린 횟수를 함께 찍는다(프로세스당 1회만 찍으면 장애가 로그에서 사라진다).
 *
 * 느린 명령 하나로 연결을 버리지도 않는다. RESP 는 순서 프로토콜이라 응답 짝만 유지하면 되므로,
 * 타임아웃된 호출은 대기열에 "버려진 자리"로 남겨 두고(=순서 보존) 호출자에게만 실패를 돌려준다.
 * 연결을 실제로 접는 건 소켓 오류/종료이거나, 타임아웃이 연속으로 쌓여 서버가 응답을 못 주고
 * 있다고 봐야 할 때뿐이다.
 */
import net from "node:net";
import tls from "node:tls";

export type RedisReply = string | number | null | RedisReply[];
export type ParsedReply = { value: RedisReply; next: number; error?: string };
export type RedisTarget = { host: string; port: number; tls: boolean; username?: string; password?: string; db?: number };

const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 1_000;
/** 죽은 Redis 에 매 요청 재연결을 시도하면 지연이 요청마다 붙는다 — 쿨다운을 둔다. */
const RECONNECT_COOLDOWN_MS = 5_000;

/** 쿨다운은 배포 환경에 따라 조정한다(테스트는 0). 매번 읽어 재시작 없이 바뀌게 둔다. */
function reconnectCooldownMs(): number {
  const raw = Number(process.env.REDIS_RECONNECT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : RECONNECT_COOLDOWN_MS;
}
/** 이만큼 연속으로 타임아웃하면 지연 스파이크가 아니라 죽은 연결로 본다. */
const MAX_CONSECUTIVE_TIMEOUTS = 5;
/** 응답이 끝내 오지 않은 자리가 이만큼 쌓이면 대기열이 무한히 늘기 전에 접는다. */
const MAX_ABANDONED_WAITERS = 64;
/** 같은 종류의 경고는 이 간격으로만 찍고, 그 사이 발생 횟수를 함께 남긴다. */
const WARN_THROTTLE_MS = 60_000;

const CRLF = "\r\n";

/** RESP 배열 인코딩 (모든 인자는 bulk string) */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}${CRLF}`)];
  for (const arg of args) {
    const body = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${body.length}${CRLF}`), body, Buffer.from(CRLF));
  }
  return Buffer.concat(parts);
}

/**
 * RESP2 응답 하나를 파싱한다. 버퍼가 아직 모자라면 null(= 더 받아야 함).
 * 오류 응답(-ERR ...)은 throw 하지 않고 `error` 로 실어 보낸다 — 파이프라인 순서를 잃지 않으려고.
 */
export function parseReply(buf: Buffer, start = 0): ParsedReply | null {
  if (start >= buf.length) return null;
  const lineEnd = buf.indexOf(CRLF, start + 1, "latin1");
  if (lineEnd === -1) return null;
  const line = buf.toString("utf8", start + 1, lineEnd);
  const after = lineEnd + 2;

  switch (String.fromCharCode(buf[start])) {
    case "+":
      return { value: line, next: after };
    case "-":
      return { value: null, next: after, error: line };
    case ":":
      return { value: Number(line), next: after };
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count < 0) return { value: null, next: after };
      const items: RedisReply[] = [];
      let cursor = after;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      return { value: null, next: after, error: `unsupported RESP prefix ${String.fromCharCode(buf[start])}` };
  }
}

/** redis://[user:pass@]host[:port][/db] · rediss:// (TLS). 형식이 아니면 null. */
export function parseRedisUrl(raw: string): RedisTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
  const dbPath = url.pathname.replace(/^\//, "");
  const db = dbPath === "" ? undefined : Number(dbPath);
  return {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 6379,
    tls: url.protocol === "rediss:",
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: db !== undefined && Number.isInteger(db) && db >= 0 ? db : undefined,
  };
}

// ── 연결 상태 ──
/** `abandoned` 는 호출자에게 이미 실패를 돌려준 자리 — 응답 순서를 맞추려고 대기열에는 남긴다. */
type Waiter = { resolve: (r: ParsedReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null; abandoned: boolean };

let target: RedisTarget | null | undefined; // undefined = env 아직 안 읽음
let sock: net.Socket | null = null;
let ready: Promise<net.Socket> | null = null;
let waiters: Waiter[] = [];
let inbox: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let downUntil = 0;
let consecutiveTimeouts = 0;
let abandonedWaiters = 0;

// ── 관측 ──
export type RedisHealth = {
  /** REDIS_URL 이 유효하게 설정되어 있는가 */
  enabled: boolean;
  /** 지금 살아 있는 연결이 있는가 */
  connected: boolean;
  /** 쿨다운 중(=다음 재연결 시도까지 남은 ms). 0 이면 즉시 시도한다. */
  cooldownMs: number;
  /** 성공적으로 짝지어진 응답 수 */
  commands: number;
  /** 예산 안에 응답이 오지 않은 명령 수 */
  timeouts: number;
  /** **인메모리 한도로 떨어진 횟수** — 이 값이 늘면 한도가 replica 배수로 느슨해지고 있다는 뜻 */
  fallbacks: number;
  /** 연속 폴백이 시작된 시각(ms epoch). 정상으로 돌아오면 null. */
  degradedSince: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
};

const health = {
  commands: 0,
  timeouts: 0,
  fallbacks: 0,
  degradedSince: null as number | null,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
};

/** 공유 한도가 실제로 공유되고 있는지 앱이 읽을 수 있는 단일 지점. */
export function getRedisHealth(): RedisHealth {
  return {
    enabled: isRedisEnabled(),
    connected: sock !== null && !sock.destroyed,
    cooldownMs: Math.max(0, downUntil - Date.now()),
    commands: health.commands,
    timeouts: health.timeouts,
    fallbacks: health.fallbacks,
    degradedSince: health.degradedSince,
    lastError: health.lastError,
    lastErrorAt: health.lastErrorAt,
  };
}

/** 테스트/운영 리셋 — 카운터만 되돌린다(연결은 건드리지 않는다). */
export function resetRedisHealth(): void {
  health.commands = 0;
  health.timeouts = 0;
  health.fallbacks = 0;
  health.degradedSince = null;
  health.lastError = null;
  health.lastErrorAt = null;
  warnState.clear();
}

const warnState = new Map<string, { last: number; suppressed: number }>();

/**
 * 같은 사연의 경고를 주기당 1회로 묶되, 눌린 횟수를 함께 남긴다.
 * 프로세스당 1회만 찍으면 장애가 두 번째부터 로그에서 사라진다.
 */
function warnThrottled(kind: string, message: string): void {
  if (process.env.NODE_ENV === "test") return;
  const now = Date.now();
  const prev = warnState.get(kind);
  if (prev && now - prev.last < WARN_THROTTLE_MS) {
    prev.suppressed += 1;
    return;
  }
  const suppressed = prev?.suppressed ?? 0;
  const since = prev ? Math.round((now - prev.last) / 1000) : 0;
  warnState.set(kind, { last: now, suppressed: 0 });
  console.warn(`[notikit] ${message}${suppressed > 0 ? ` (+${suppressed} more in the last ${since}s)` : ""}`);
}

function recordError(err: Error): void {
  health.lastError = err.message;
  health.lastErrorAt = Date.now();
}

/** Redis 대신 인메모리로 판정했다 — 조용히 넘기지 않고 센다. */
function recordFallback(reason: string): null {
  health.fallbacks += 1;
  health.degradedSince ??= Date.now();
  warnThrottled(
    "fallback",
    `redis is degraded (${reason}) — rate limits fall back to per-instance counting; ${health.fallbacks} requests affected`
  );
  return null;
}

function recordSuccess(): void {
  consecutiveTimeouts = 0;
  health.commands += 1;
  if (health.degradedSince !== null) {
    health.degradedSince = null;
    warnThrottled("recovered", "redis recovered — rate limits are shared again");
  }
}

function resolveTarget(): RedisTarget | null {
  if (target !== undefined) return target;
  const raw = process.env.REDIS_URL?.trim();
  target = raw ? parseRedisUrl(raw) : null;
  if (raw && !target) {
    console.warn("[notikit] REDIS_URL is not a redis:// or rediss:// URL — shared rate limiting stays disabled");
  }
  return target;
}

/** REDIS_URL 이 유효하게 설정되어 있는가 (연결 성공 여부와는 별개) */
export function isRedisEnabled(): boolean {
  return resolveTarget() !== null;
}

/**
 * 연결을 끊고 대기 중인 명령을 모두 거절한다. 다음 시도는 쿨다운 이후.
 * 느린 명령 하나로는 부르지 않는다 — 소켓 오류/종료이거나 타임아웃이 연속으로 쌓였을 때만.
 */
function teardown(err: Error): void {
  const dead = sock;
  sock = null;
  ready = null;
  inbox = Buffer.alloc(0);
  const pending = waiters;
  waiters = [];
  abandonedWaiters = 0;
  consecutiveTimeouts = 0;
  for (const w of pending) {
    if (w.timer) clearTimeout(w.timer);
    if (!w.abandoned) w.reject(err); // 버려진 자리는 이미 실패를 돌려줬다
  }
  dead?.removeAllListeners();
  dead?.destroy();
  recordError(err);
  downUntil = Date.now() + reconnectCooldownMs();
}

function onData(chunk: Buffer): void {
  inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk]);
  for (;;) {
    const parsed = parseReply(inbox, 0);
    if (!parsed) break;
    inbox = inbox.subarray(parsed.next);
    const waiter = waiters.shift();
    if (!waiter) continue; // 짝 없는 응답(있을 수 없음) — 버린다
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abandoned) {
      // 늦게 온 응답. 호출자는 이미 폴백했지만 **연결은 멀쩡하다** — 자리만 비우고 계속 쓴다.
      abandonedWaiters -= 1;
      consecutiveTimeouts = 0;
      continue;
    }
    recordSuccess();
    waiter.resolve(parsed);
  }
}

function send(socket: net.Socket, args: string[]): Promise<ParsedReply> {
  return new Promise<ParsedReply>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, timer: null, abandoned: false };
    // 타임아웃은 이 호출만 실패시킨다. 자리를 대기열에 남겨 두므로 응답 순서는 그대로 유지된다.
    waiter.timer = setTimeout(() => {
      waiter.timer = null;
      waiter.abandoned = true;
      abandonedWaiters += 1;
      consecutiveTimeouts += 1;
      health.timeouts += 1;
      const err = new Error(`redis ${args[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`);
      recordError(err);
      // 한 번의 지연 스파이크로는 연결을 버리지 않는다 — 계속 쌓일 때만 죽은 것으로 본다.
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS || abandonedWaiters >= MAX_ABANDONED_WAITERS) {
        teardown(new Error(`redis stopped answering (${consecutiveTimeouts} consecutive timeouts)`));
      } else {
        warnThrottled("slow", `redis ${args[0]} timed out after ${COMMAND_TIMEOUT_MS}ms — keeping the connection`);
      }
      reject(err);
    }, COMMAND_TIMEOUT_MS);
    waiter.timer.unref?.();
    waiters.push(waiter);
    socket.write(encodeCommand(args), (err) => {
      if (err) teardown(err);
    });
  });
}

/**
 * 요청 경로용 예산. 명령 타임아웃(1s)은 요청 하나가 기다리기엔 길다 —
 * 예산을 넘기면 호출자는 즉시 폴백하고, 대기열의 자리는 그대로 두어 순서를 지킨다.
 */
function withBudget(p: Promise<ParsedReply>, budgetMs: number): Promise<ParsedReply | null> {
  if (!(budgetMs > 0) || budgetMs >= COMMAND_TIMEOUT_MS) return p.catch(() => null);
  return new Promise<ParsedReply | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

async function openSocket(t: RedisTarget): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = t.tls ? tls.connect({ host: t.host, port: t.port, servername: t.host }) : net.connect({ host: t.host, port: t.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    const onError = (e: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    socket.once("error", onError);
    socket.once(t.tls ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function connect(t: RedisTarget): Promise<net.Socket> {
  const socket = await openSocket(t);
  socket.setNoDelay(true);
  socket.unref(); // rate limit 카운터가 Next/워커 프로세스 종료를 붙잡지 않게
  socket.on("data", onData);
  socket.on("error", (e: Error) => teardown(e));
  socket.on("close", () => teardown(new Error("redis connection closed")));

  // 핸드셰이크는 sock 을 공개하기 전에 끝낸다 — 인증 전 소켓이 다른 호출에 새지 않게
  const handshake = async (args: string[]) => {
    const reply = await send(socket, args);
    if (reply.error) throw new Error(reply.error);
  };
  try {
    if (t.password) await handshake(t.username ? ["AUTH", t.username, t.password] : ["AUTH", t.password]);
    if (t.db) await handshake(["SELECT", String(t.db)]);
  } catch (e) {
    socket.removeAllListeners();
    socket.destroy();
    throw e;
  }

  sock = socket;
  return socket;
}

async function ensure(): Promise<net.Socket | null> {
  const t = resolveTarget();
  if (!t) return null;
  if (sock && !sock.destroyed) return sock;
  if (Date.now() < downUntil) return null;
  if (!ready) {
    ready = connect(t).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      warnThrottled("connect", `redis is unavailable (${err.message}) — falling back to in-memory limits`);
      teardown(err);
      throw err;
    });
  }
  try {
    return await ready;
  } catch {
    return null;
  }
}

/**
 * 고정창 카운터 증가. 현재 창의 누적 횟수를 돌려주고, 실패하면 null.
 * INCR 와 PEXPIRE 를 파이프라인으로 한 번에 보낸다(왕복 1회).
 *
 * `budgetMs` 는 **호출자가 기다릴 수 있는 시간**이다. 넘기면 null(=인메모리 폴백)을 돌려주되
 * 연결은 유지한다 — 느린 응답 하나 때문에 모든 replica 가 한도를 잃으면 안 된다.
 */
export async function redisIncrementWindow(key: string, ttlMs: number, budgetMs = COMMAND_TIMEOUT_MS): Promise<number | null> {
  try {
    const socket = await ensure();
    if (!socket) return recordFallback("no connection");
    const incr = send(socket, ["INCR", key]);
    // PEXPIRE 실패는 판정에 영향이 없다(창마다 키가 다르고 TTL 은 다음 증가에서 다시 걸린다).
    const expire = send(socket, ["PEXPIRE", key, String(Math.max(1, Math.round(ttlMs)))]);
    expire.catch(() => {});
    const reply = await withBudget(incr, budgetMs);
    if (!reply) return recordFallback(`INCR exceeded the ${budgetMs}ms budget`);
    if (reply.error || typeof reply.value !== "number") return recordFallback(reply.error ?? "unexpected reply");
    return reply.value;
  } catch (e) {
    // 연결 장애 — 인메모리 판정으로 계속 간다
    return recordFallback(e instanceof Error ? e.message : String(e));
  }
}

/** 연결 종료 + env 재해석. 종료 훅과 테스트에서 쓴다. */
export function resetRedis(): void {
  target = undefined;
  downUntil = 0;
  consecutiveTimeouts = 0;
  abandonedWaiters = 0;
  const dead = sock;
  sock = null;
  ready = null;
  inbox = Buffer.alloc(0);
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    if (w.timer) clearTimeout(w.timer);
    if (!w.abandoned) w.reject(new Error("redis client reset"));
  }
  dead?.removeAllListeners();
  dead?.destroy();
}
