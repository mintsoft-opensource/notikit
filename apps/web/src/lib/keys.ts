import { randomBytes } from "node:crypto";

export function generateApiKey(prefix = "nk"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function generateApiSecret(): string {
  return `sk_${randomBytes(24).toString("base64url")}`;
}

/** 관리자(web) API 인증 — x-admin-token 헤더 == ADMIN_TOKEN */
export function requireAdmin(req: Request): boolean {
  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  return !!expected && token === expected;
}
