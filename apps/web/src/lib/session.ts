import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

// 동시 scrypt 연산 상한 (메모리·워커 고갈 방어). 초과분은 큐잉하되, 큐 길이 상한 초과 시 즉시 거부.
export class ScryptOverloadError extends Error {
  constructor() {
    super("hashing capacity exceeded");
    this.name = "ScryptOverloadError";
  }
}
/** 유한 정수 env 파싱 — 범위를 벗어나거나 비정상이면 기본값 (설정 오류로 인한 무한 큐잉/스톨 방지) */
function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return def;
  return n;
}
const SCRYPT_MAX = intEnv(process.env.SCRYPT_CONCURRENCY, 2, 1, 64);
const SCRYPT_MAX_QUEUE = intEnv(process.env.SCRYPT_MAX_QUEUE, 50, 0, 100_000);
let scryptActive = 0;
const scryptQueue: Array<() => void> = [];
async function acquireScrypt(): Promise<void> {
  if (scryptActive < SCRYPT_MAX) {
    scryptActive += 1;
    return;
  }
  // 큐가 이미 가득 → fail-fast (무한 큐잉으로 인한 메모리 고갈 방지)
  if (scryptQueue.length >= SCRYPT_MAX_QUEUE) throw new ScryptOverloadError();
  await new Promise<void>((resolve) => scryptQueue.push(resolve));
  scryptActive += 1;
}
function releaseScrypt(): void {
  scryptActive -= 1;
  scryptQueue.shift()?.();
}

function scrypt(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk as Buffer)));
  });
}

async function boundedScrypt(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  await acquireScrypt();
  try {
    return await scrypt(password, salt, keylen, options);
  } finally {
    releaseScrypt();
  }
}

export const SESSION_COOKIE = "notikit_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

// OWASP 권장 상향 (N=2^17, r=8, p=1). 파라미터는 해시 문자열에 저장 → 향후 이관 가능.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

export type SessionToken = { userId: string; ver: number };

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.NOTIKIT_ENCRYPTION_KEY;
  if (!s) throw new Error("SESSION_SECRET or NOTIKIT_ENCRYPTION_KEY is required");
  return s;
}

// ── 비밀번호 해시 (scrypt async, 파라미터 임베드) ─────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await boundedScrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length === 6 && parts[0] === "scrypt") {
    const [, N, r, p, saltHex, hashHex] = parts;
    const hash = Buffer.from(hashHex, "hex");
    const dk = await boundedScrypt(password, Buffer.from(saltHex, "hex"), hash.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return hash.length === dk.length && timingSafeEqual(hash, dk);
  }
  // 레거시 "salt:hash" (파라미터 없음) — 로그인 성공 시 상위에서 재해시 권장
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, "hex");
  const dk = await boundedScrypt(password, Buffer.from(saltHex, "hex"), hash.length, {});
  return hash.length === dk.length && timingSafeEqual(hash, dk);
}

/** 존재하지 않는 계정에도 동일 비용을 지불하기 위한 더미 해시 (타이밍/존재여부 방어) */
let DUMMY_HASH: string | null = null;
export async function dummyVerify(password: string): Promise<void> {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword("notikit-dummy-password");
  await verifyPassword(password, DUMMY_HASH);
}

// ── 세션 토큰 (stateless, 서명; ver 로 서버측 무효화 지원) ─────
function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function createSessionToken(data: SessionToken): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ ...data, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** 서명·만료·형식 검증 (DB 조회 없음). 유효하면 {userId, ver}. */
export function verifySessionToken(token: string | undefined | null): SessionToken | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof obj.exp !== "number" || obj.exp < Date.now()) return null;
    if (typeof obj.userId !== "string" || !obj.userId) return null;
    if (typeof obj.ver !== "number") return null;
    return { userId: obj.userId, ver: obj.ver };
  } catch {
    return null;
  }
}

// ── Cookie 파싱 (route handler 용) ────────────────────────────
export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return undefined; // 손상된 인코딩 → 세션 없음으로 처리
    }
  }
  return undefined;
}

export function sessionTokenFromRequest(req: Request): SessionToken | null {
  return verifySessionToken(parseCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

/** prod 는 기본 Secure. 로컬 http 는 COOKIE_INSECURE=true 로 예외. */
export function sessionCookieAttributes(maxAgeSec = SESSION_TTL_MS / 1000) {
  const secure = process.env.COOKIE_INSECURE === "true" ? false : process.env.NODE_ENV === "production";
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: maxAgeSec };
}
