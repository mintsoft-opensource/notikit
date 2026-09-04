import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export function generateApiKey(prefix = "nk"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function generateApiSecret(): string {
  return `sk_${randomBytes(24).toString("base64url")}`;
}

/** api-secret 은 평문 저장 금지 — sha256 해시로 저장·비교 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** 타이밍 안전 비교 */
export function verifySecret(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(candidate), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 관리자(web) API 인증 — x-admin-token 헤더 == ADMIN_TOKEN */
export function requireAdmin(req: Request): boolean {
  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  return !!expected && !!token && token === expected;
}
