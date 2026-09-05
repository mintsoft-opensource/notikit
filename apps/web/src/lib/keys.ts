import {
  randomBytes,
  createHmac,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { getSessionFromRequest } from "@/lib/session";

export function generateApiKey(prefix = "nk"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function generateApiSecret(): string {
  return `sk_${randomBytes(24).toString("base64url")}`;
}

/** NOTIKIT_ENCRYPTION_KEY 로부터 32바이트 AES 키 파생 */
function encKey(): Buffer {
  const k = process.env.NOTIKIT_ENCRYPTION_KEY;
  if (!k) throw new Error("NOTIKIT_ENCRYPTION_KEY is not set");
  return createHash("sha256").update(k).digest();
}

/** api-secret 암호화 저장 (AES-256-GCM at-rest — 평문 저장 금지, 단 서버는 HMAC 위해 복호 가능해야 함) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(enc: string): string {
  const [iv, tag, ct] = enc.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** 제출된 secret 이 저장된 암호문의 원본과 일치하는지 (타이밍 안전) */
export function verifySecret(candidate: string, enc: string): boolean {
  try {
    const real = Buffer.from(decryptSecret(enc), "utf8");
    const cand = Buffer.from(candidate, "utf8");
    return real.length === cand.length && timingSafeEqual(real, cand);
  } catch {
    return false;
  }
}

/** identity 검증 해시 = HMAC-SHA256(externalId, secret). 고객 서버가 계산해 클라이언트에 전달. */
export function computeIdentityHash(externalId: string, enc: string): string {
  return createHmac("sha256", decryptSecret(enc)).update(externalId).digest("hex");
}

export function verifyIdentity(externalId: string, hash: string, enc: string): boolean {
  try {
    const a = Buffer.from(computeIdentityHash(externalId, enc), "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 관리자(web) API 인증 — x-admin-token 헤더 == ADMIN_TOKEN */
export function requireAdmin(req: Request): boolean {
  return getAdminContext(req) !== null;
}

/**
 * 인증 컨텍스트 해석.
 * - 세션 쿠키(로그인 계정) → 해당 유저의 org 로 스코프
 * - x-admin-token == ADMIN_TOKEN → superadmin(전체 org, 하위호환: E2E/curl)
 */
export function getAdminContext(req: Request): { orgId: string | null; superadmin: boolean } | null {
  const session = getSessionFromRequest(req);
  if (session) return { orgId: session.orgId, superadmin: false };

  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  if (expected && token && token === expected) return { orgId: null, superadmin: true };

  return null;
}
