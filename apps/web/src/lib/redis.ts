/**
 * 최소 Redis(RESP2) 클라이언트 — 공유 rate limit 카운터 전용.
 *
 * 의존성을 늘리지 않으려고 node:net/tls 위에 직접 얹었다. 쓰는 명령은 INCR/PEXPIRE 뿐이라
 * 풀 클라이언트(ioredis)를 들일 이유가 없고, 온프렘 번들 크기도 그대로 둔다.
 *
 * **요청 경로를 막지 않는다**: 연결 실패·타임아웃·오류 응답은 전부 null 로 떨어지고,
 * 호출자(rate-limit)는 인메모리 판정으로 계속 간다. Redis 가 죽었다고 발송 API 가 죽으면 안 된다.
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
type Waiter = { resolve: (r: ParsedReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let target: RedisTarget | null | undefined; // undefined = env 아직 안 읽음
let sock: net.Socket | null = null;
let ready: Promise<net.Socket> | null = null;
let waiters: Waiter[] = [];
let inbox: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let downUntil = 0;

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

/** 연결을 끊고 대기 중인 명령을 모두 거절한다. 다음 시도는 쿨다운 이후. */
function teardown(err: Error): void {
  const dead = sock;
  sock = null;
  ready = null;
  inbox = Buffer.alloc(0);
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    clearTimeout(w.timer);
    w.reject(err);
  }
  dead?.removeAllListeners();
  dead?.destroy();
  downUntil = Date.now() + RECONNECT_COOLDOWN_MS;
}

function onData(chunk: Buffer): void {
  inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk]);
  for (;;) {
    const parsed = parseReply(inbox, 0);
    if (!parsed) break;
    inbox = inbox.subarray(parsed.next);
    const waiter = waiters.shift();
    if (!waiter) continue; // 짝 없는 응답(있을 수 없음) — 버린다
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  }
}

function send(socket: net.Socket, args: string[]): Promise<ParsedReply> {
  return new Promise<ParsedReply>((resolve, reject) => {
    // 타임아웃이면 응답 순서를 신뢰할 수 없다 → 연결을 버린다(대기 중인 것도 함께 거절됨)
    const timer = setTimeout(() => teardown(new Error(`redis ${args[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`)), COMMAND_TIMEOUT_MS);
    waiters.push({ resolve, reject, timer });
    socket.write(encodeCommand(args), (err) => {
      if (err) teardown(err);
    });
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
      console.warn(`[notikit] redis is unavailable (${err.message}) — falling back to in-memory limits`);
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
 */
export async function redisIncrementWindow(key: string, ttlMs: number): Promise<number | null> {
  try {
    const socket = await ensure();
    if (!socket) return null;
    const incr = send(socket, ["INCR", key]);
    const expire = send(socket, ["PEXPIRE", key, String(Math.max(1, Math.round(ttlMs)))]);
    const [reply] = await Promise.all([incr, expire]);
    if (reply.error || typeof reply.value !== "number") return null;
    return reply.value;
  } catch {
    return null; // 연결 장애 — 인메모리 판정으로 계속 간다
  }
}

/** 연결 종료 + env 재해석. 종료 훅과 테스트에서 쓴다. */
export function resetRedis(): void {
  target = undefined;
  downUntil = 0;
  const dead = sock;
  sock = null;
  ready = null;
  inbox = Buffer.alloc(0);
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    clearTimeout(w.timer);
    w.reject(new Error("redis client reset"));
  }
  dead?.removeAllListeners();
  dead?.destroy();
}
