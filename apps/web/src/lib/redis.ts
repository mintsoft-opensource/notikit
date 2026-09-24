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
 *
 * **예산은 연결 대기까지 포함한다.** 예전에는 INCR 만 예산으로 감쌌는데, Redis 가 처음 느려지는
 * 순간에는 아직 연결이 없다 — 그때 모든 동시 요청이 같은 `ready` 를 CONNECT_TIMEOUT_MS(2초)까지
 * 함께 기다렸다. 호출자가 약속한 200ms 예산이 2초가 되고, 로그인처럼 in-flight 슬롯을 쥔 채
 * 기다리는 라우트는 인증과 무관하게 503 을 돌려줬다. 지금은 연결+명령 전체가 하나의 마감이다.
 *
 * **살아 있지만 느린 Redis** 에는 차단기를 둔다. 연결이 끊기지 않으면 쿨다운이 걸리지 않아
 * 모든 요청이 매번 예산을 꽉 채워 낸다(= 지연이 요청마다 그대로 붙는다). 예산 초과가 연속으로
 * 쌓이면 잠시 아예 묻지 않고 즉시 폴백하고, 창이 지나면 **한 요청만** 통과시켜 회복을 재확인한다.
 */
import net from "node:net";
import tls from "node:tls";
import { errorMessage, logThrottled } from "@/lib/logger";

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

/**
 * 예산 초과가 이만큼 **연속**으로 나면 "살아 있지만 느림"으로 보고 차단기를 연다.
 * 1 로 두면 지연 스파이크 한 번에 공유 한도를 버리고, 크게 두면 그만큼 요청이 예산을 문다.
 */
const DEGRADED_TRIP_MISSES = 3;
/** 차단기가 열려 있는 시간. 지나면 **한 요청만** 통과시켜(probe) 회복을 확인한다. */
const DEGRADED_PROBE_MS = 3_000;

/** 차단 시간은 배포 환경에 따라 조정한다(테스트는 짧게). 매번 읽어 재시작 없이 바뀌게 둔다. */
function degradedProbeMs(): number {
  const raw = Number(process.env.REDIS_DEGRADED_PROBE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEGRADED_PROBE_MS;
}

/** 공유 카운터 키 접두사 — rate limit 창 키(`nk:rl`)와 섞이지 않게 */
const SHARED_STAT_PREFIX = "nk:stat";
/** 공유 카운터 수명. 아무도 안 늘리면 결국 사라지되, 주간 회고에는 남아 있을 만큼. */
const SHARED_STAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 공유 카운터 플러시 주기 — 요청마다 보내면 관측이 부하가 된다. */
const SHARED_STAT_FLUSH_MS = 5_000;

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

// ── "살아 있지만 느림" 차단기 ──
/** 이 시각까지는 묻지 않고 바로 폴백한다. */
let breakerUntil = 0;
/** 연속 예산 초과 횟수 — 성공 한 번이면 0 으로 돌아간다. */
let budgetMisses = 0;
/** 차단 창이 지난 뒤 회복을 재확인하는 요청이 이미 나가 있는가(동시에 여럿이 나가지 않게). */
let probing = false;

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
  /** 차단기가 열려 있어 **묻지도 않고** 폴백한 횟수(= 예산을 물지 않은 요청 수) */
  shortCircuits: number;
  /** 차단기가 닫힐 때까지 남은 ms. 0 이면 열려 있지 않다. */
  breakerMs: number;
  /** 연속 폴백이 시작된 시각(ms epoch). 정상으로 돌아오면 null. */
  degradedSince: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
};

const health = {
  commands: 0,
  timeouts: 0,
  fallbacks: 0,
  shortCircuits: 0,
  degradedSince: null as number | null,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
};

/**
 * 공유 한도가 실제로 공유되고 있는지 앱이 읽을 수 있는 단일 지점.
 *
 * **이 값들은 프로세스 단위다.** replica 가 둘이면 두 프로세스의 숫자를 더해야 전체가 된다 —
 * 노출 지점(`/api/internal/metrics`)이 그렇게 표시하고, 같은 값의 클러스터 합계는
 * `addSharedCounter`/`readSharedCounters` 가 Redis 에 따로 모은다.
 */
export function getRedisHealth(): RedisHealth {
  return {
    enabled: isRedisEnabled(),
    connected: sock !== null && !sock.destroyed,
    cooldownMs: Math.max(0, downUntil - Date.now()),
    commands: health.commands,
    timeouts: health.timeouts,
    fallbacks: health.fallbacks,
    shortCircuits: health.shortCircuits,
    breakerMs: Math.max(0, breakerUntil - Date.now()),
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
  health.shortCircuits = 0;
  health.degradedSince = null;
  health.lastError = null;
  health.lastErrorAt = null;
  breakerUntil = 0;
  budgetMisses = 0;
  probing = false;
  pendingStats.clear();
}

function recordError(err: Error): void {
  health.lastError = err.message;
  health.lastErrorAt = Date.now();
}

/** Redis 대신 인메모리로 판정했다 — 조용히 넘기지 않고 센다. */
function recordFallback(reason: string): null {
  health.fallbacks += 1;
  health.degradedSince ??= Date.now();
  addSharedCounter("ratelimit.fallback");
  logThrottled("warn", "redis.fallback", { reason, affected: health.fallbacks });
  return null;
}

/**
 * 예산을 넘겼다(= 연결이든 명령이든 제때 답이 없었다). 연속으로 쌓이면 차단기를 연다.
 * "연결 없음"은 여기로 오지 않는다 — 그쪽은 재연결 쿨다운이 이미 막아 준다.
 */
function recordBudgetMiss(reason: string): null {
  budgetMisses += 1;
  if (budgetMisses >= DEGRADED_TRIP_MISSES) {
    breakerUntil = Date.now() + degradedProbeMs();
    logThrottled("warn", "redis.breaker_open", { reason, misses: budgetMisses, probe_in_ms: degradedProbeMs() });
  }
  return recordFallback(reason);
}

/**
 * 응답이 짝지어졌다. **이것만으로 "회복"이라고 보지 않는다** — 예산을 넘겨 호출자가 이미
 * 폴백한 뒤 늦게 도착한 응답도 여기로 온다. 그걸 회복으로 치면 느린 Redis 에서는 차단기가
 * 매번 늦은 응답에 리셋되어 영영 열리지 않는다.
 */
function recordSuccess(): void {
  consecutiveTimeouts = 0;
  health.commands += 1;
  flushSharedStats();
}

/** **예산 안에** 답이 왔다 — 이때만 차단기를 닫고 "회복"이라고 말한다. */
function recordInBudgetSuccess(): void {
  budgetMisses = 0;
  breakerUntil = 0;
  if (health.degradedSince !== null) {
    health.degradedSince = null;
    logThrottled("info", "redis.recovered", {});
  }
}

/**
 * 차단기 게이트.
 * - `closed`: 평소. 그냥 묻는다.
 * - `open`: **아무것도 묻지 않고** 즉시 폴백한다(예산 0 — 지연이 요청에 붙지 않는다).
 * - `probe`: 창이 지나 회복을 재확인할 차례. **한 번에 한 요청만** 통과시킨다 —
 *   전부 통과시키면 회복 확인 자체가 다시 부하가 되고, 느린 Redis 는 그대로 느리다.
 */
function breakerGate(): "closed" | "open" | "probe" {
  if (breakerUntil === 0) return "closed";
  if (Date.now() < breakerUntil || probing) return "open";
  probing = true;
  return "probe";
}

/** probe 가 끝났다 — 실패했으면 창을 다시 연다. 성공은 recordSuccess 가 차단기를 닫는다. */
function endProbe(recovered: boolean): void {
  probing = false;
  if (!recovered && breakerUntil !== 0) breakerUntil = Date.now() + degradedProbeMs();
}

// ── 공유(클러스터) 카운터 ──
/**
 * 아직 Redis 에 못 올린 증분. **로컬에 모아 뒀다 연결이 살아날 때 한 번에 보낸다** —
 * 하필 이 카운터들이 늘어나는 때가 Redis 가 아플 때라, 그때 바로 보내려 하면 영원히 못 보낸다.
 */
const pendingStats = new Map<string, number>();
let lastStatFlush = 0;
let flushingStats = false;

/**
 * 클러스터 전체에서 합산되는 카운터를 올린다(best-effort, 논블로킹).
 * replica 가 둘이면 프로세스 카운터는 각자의 조각일 뿐이라 숫자가 의미를 잃는다 —
 * Redis 가 있을 때는 여기에 합을 모으고, 없으면 노출 지점이 "per-process" 라고 표시한다.
 */
export function addSharedCounter(name: string, delta = 1): void {
  if (delta <= 0 || !isRedisEnabled()) return;
  pendingStats.set(name, (pendingStats.get(name) ?? 0) + delta);
}

/** 모아 둔 증분을 흘려보낸다. 요청 경로를 막지 않고, 실패하면 되돌려 다음 기회를 노린다. */
function flushSharedStats(): void {
  if (flushingStats || pendingStats.size === 0) return;
  const socket = sock;
  if (!socket || socket.destroyed) return;
  const now = Date.now();
  if (now - lastStatFlush < SHARED_STAT_FLUSH_MS) return;
  lastStatFlush = now;
  flushingStats = true;

  const batch = [...pendingStats];
  pendingStats.clear();
  void (async () => {
    try {
      for (const [name, delta] of batch) {
        const key = `${SHARED_STAT_PREFIX}:${name}`;
        const incr = send(socket, ["INCRBY", key, String(delta)]);
        const expire = send(socket, ["PEXPIRE", key, String(SHARED_STAT_TTL_MS)]);
        expire.catch(() => {});
        await incr;
      }
    } catch {
      // 못 보냈으면 잃지 않는다 — 다음 성공에 다시 태운다
      for (const [name, delta] of batch) pendingStats.set(name, (pendingStats.get(name) ?? 0) + delta);
    } finally {
      flushingStats = false;
    }
  })();
}

/**
 * 클러스터 합계 읽기 — 운영 지표 노출용. Redis 가 없거나 답이 늦으면 null
 * (그 경우 호출자는 프로세스 단위 숫자만 "per-process" 라고 밝혀 보여 준다).
 */
export async function readSharedCounters(
  names: readonly string[],
  budgetMs = 200
): Promise<Record<string, number> | null> {
  // 차단기 상태는 **읽기만** 한다. `breakerGate()` 는 probe 자격을 소비하므로 여기서 부르면
  // 판정 경로가 쓸 probe 를 지표 조회가 가로채 차단이 영영 풀리지 않는다.
  if (names.length === 0 || !isRedisEnabled() || breakerUntil !== 0) return null;
  const budget = deadline(budgetMs);
  try {
    const socket = await budget.race(ensure());
    if (socket === EXPIRED || !socket) return null;
    const mget = send(socket, ["MGET", ...names.map((n) => `${SHARED_STAT_PREFIX}:${n}`)]);
    const reply = await budget.race(mget, budgetMs < COMMAND_TIMEOUT_MS);
    if (reply === EXPIRED || !reply || reply.error || !Array.isArray(reply.value)) return null;
    const out: Record<string, number> = {};
    names.forEach((name, i) => {
      const raw = (reply.value as RedisReply[])[i];
      const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
      out[name] = Number.isFinite(n) ? n : 0;
    });
    return out;
  } catch {
    return null;
  } finally {
    budget.dispose();
  }
}

function resolveTarget(): RedisTarget | null {
  if (target !== undefined) return target;
  const raw = process.env.REDIS_URL?.trim();
  target = raw ? parseRedisUrl(raw) : null;
  if (raw && !target) {
    logThrottled("error", "redis.url_invalid", { expected: "redis:// or rediss://" });
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
        logThrottled("warn", "redis.slow", { command: args[0], timeout_ms: COMMAND_TIMEOUT_MS });
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

/** 예산을 넘겨 포기했음을 나타내는 표식 — `null`(정상적인 "값 없음")과 구분해야 한다. */
const EXPIRED = Symbol("budget-expired");

/**
 * 요청 하나의 **마감**. 연결 대기와 명령 응답을 같은 시계로 잰다.
 *
 * 예전에는 INCR 만 감쌌다. 그러면 Redis 가 처음 느려지는 순간(= 아직 연결이 없을 때)
 * 모든 동시 요청이 `ready` 를 CONNECT_TIMEOUT_MS 까지 같이 기다려 예산이 통째로 무의미해진다.
 * 넘기면 호출자는 즉시 폴백하고, 대기열의 자리는 그대로 두어 응답 순서를 지킨다.
 */
function deadline(budgetMs: number) {
  const until = Date.now() + Math.max(0, budgetMs);
  let timer: NodeJS.Timeout | null = null;
  let expired: Promise<typeof EXPIRED> | null = null;

  const expiry = () => {
    if (!expired) {
      expired = new Promise<typeof EXPIRED>((resolve) => {
        timer = setTimeout(() => resolve(EXPIRED), Math.max(0, until - Date.now()));
        timer.unref?.();
      });
    }
    return expired;
  };

  return {
    remaining: () => until - Date.now(),
    /**
     * `gate=false` 면 마감을 걸지 않고 그대로 기다린다.
     * 명령 단계에서 쓴다 — 호출자가 COMMAND_TIMEOUT_MS 보다 **느슨한** 예산을 줬다면
     * 먼저 끝나는 쪽은 어차피 명령 타임아웃이고, 그쪽이 연결 상태(health)를 갱신한다.
     * 여기에 굳이 더 이른 타이머를 얹으면 둘이 1ms 차이로 경합해 판정이 흔들린다.
     */
    race: async <T>(p: Promise<T>, gate = true): Promise<T | null | typeof EXPIRED> => {
      const safe = p.catch(() => null);
      return gate ? Promise.race([safe, expiry()]) : safe;
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
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
      logThrottled("warn", "redis.unavailable", { reason: err.message });
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
  const gate = breakerGate();
  if (gate === "open") {
    // 느린 Redis 를 또 기다리지 않는다 — 예산을 물지 않고 바로 로컬 판정으로 간다
    health.shortCircuits += 1;
    return recordFallback("breaker open (redis is slow)");
  }

  const budget = deadline(budgetMs);
  let recovered = false;
  try {
    // **연결 대기도 예산 안이다.** 첫 지연 스파이크에서 모든 요청이 연결 타임아웃(2초)까지
    // 같은 `ready` 를 함께 기다리던 경로가 여기서 끊긴다.
    const socket = await budget.race(ensure());
    if (socket === EXPIRED) return recordBudgetMiss(`connect exceeded the ${budgetMs}ms budget`);
    if (!socket) return recordFallback("no connection");

    const incr = send(socket, ["INCR", key]);
    // PEXPIRE 실패는 판정에 영향이 없다(창마다 키가 다르고 TTL 은 다음 증가에서 다시 걸린다).
    const expire = send(socket, ["PEXPIRE", key, String(Math.max(1, Math.round(ttlMs)))]);
    expire.catch(() => {});

    // 호출자가 명령 타임아웃보다 **타이트한** 예산을 줬을 때만 마감을 건다(요청 경로가 그렇다).
    const reply = await budget.race(incr, budgetMs < COMMAND_TIMEOUT_MS);
    if (reply === EXPIRED) return recordBudgetMiss(`INCR exceeded the ${budgetMs}ms budget`);
    if (!reply) return recordBudgetMiss("INCR did not answer in time");
    if (reply.error || typeof reply.value !== "number") return recordFallback(reply.error ?? "unexpected reply");
    recovered = true;
    recordInBudgetSuccess();
    return reply.value;
  } catch (e) {
    // 연결 장애 — 인메모리 판정으로 계속 간다
    return recordFallback(errorMessage(e));
  } finally {
    budget.dispose();
    if (gate === "probe") endProbe(recovered);
  }
}

/** 연결 종료 + env 재해석. 종료 훅과 테스트에서 쓴다. */
export function resetRedis(): void {
  target = undefined;
  downUntil = 0;
  consecutiveTimeouts = 0;
  abandonedWaiters = 0;
  breakerUntil = 0;
  budgetMisses = 0;
  probing = false;
  flushingStats = false;
  lastStatFlush = 0;
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
