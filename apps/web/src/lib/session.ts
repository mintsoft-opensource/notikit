import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "notikit_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

export type SessionData = { userId: string; orgId: string; role: string };

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.NOTIKIT_ENCRYPTION_KEY;
  if (!s) throw new Error("SESSION_SECRET or NOTIKIT_ENCRYPTION_KEY is required");
  return s;
}

// ── 비밀번호 해시 (scrypt, 내장) ──────────────────────────────
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, "hex");
  const test = scryptSync(password, Buffer.from(saltHex, "hex"), hash.length);
  return hash.length === test.length && timingSafeEqual(hash, test);
}

// ── 세션 토큰 (stateless, 서명) ───────────────────────────────
function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function createSessionToken(data: SessionData): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ ...data, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionData | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof obj.exp !== "number" || obj.exp < Date.now()) return null;
    if (!obj.userId || !obj.orgId) return null;
    return { userId: obj.userId, orgId: obj.orgId, role: obj.role ?? "owner" };
  } catch {
    return null;
  }
}

// ── Request 의 Cookie 헤더에서 세션 추출 (route handler 용) ────
export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function getSessionFromRequest(req: Request): SessionData | null {
  return verifySessionToken(parseCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

export function sessionCookieAttributes(maxAgeSec = SESSION_TTL_MS / 1000) {
  // secure 는 TLS 뒤에서만 (COOKIE_SECURE=true). 기본 false 로 두어 http 로컬/프록시-terminated TLS 모두 동작.
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.COOKIE_SECURE === "true", path: "/", maxAge: maxAgeSec };
}
