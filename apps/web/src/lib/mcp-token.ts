import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, type Project } from "@/db/schema";

/**
 * 프로젝트 MCP 토큰.
 *
 * ADMIN_TOKEN 은 인스턴스 전체 권한이라 AI 도구 설정 파일에 넣어 돌려 쓸 값이 아니다.
 * 이 토큰은 **한 프로젝트만** 다루고, 프로젝트 화면에서 다시 발급하면 이전 값은 바로 죽는다.
 */
export const MCP_TOKEN_PREFIX = "nkm_";

export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * 256비트 난수라 느린 해시(scrypt)가 필요 없다 — 사전 대입할 공간이 없다.
 * 해시로 바로 조회하므로 비교 시간으로 값을 좁힐 수도 없다.
 */
export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

export async function resolveProjectByMcpToken(req: Request): Promise<Project | null> {
  const token = bearerToken(req);
  if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const rows = await getDb().select().from(projects).where(eq(projects.mcpTokenHash, hashMcpToken(token))).limit(1);
  return rows[0] ?? null;
}
