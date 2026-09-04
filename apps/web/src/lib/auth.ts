import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, type Project } from "@/db/schema";
import { verifySecret } from "@/lib/keys";

/**
 * SDK 요청 인증.
 * - v1: 헤더 `api-key` + `api-secret` (secret 필수·해시 검증)
 * - spring 호환: 헤더 `x-api-key` (키 자체가 인증, secret 불요)
 * 유효하면 Project, 아니면 null.
 */
export async function resolveProject(req: Request): Promise<Project | null> {
  const h = req.headers;
  const v1Key = h.get("api-key");
  const springKey = h.get("x-api-key");
  const apiKey = v1Key ?? springKey;
  if (!apiKey) return null;

  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  const project = rows[0];
  if (!project) return null;

  // v1 경로(api-key 헤더): api-secret 필수 + 해시 검증 (미제공 시 우회 방지)
  if (v1Key) {
    const apiSecret = h.get("api-secret");
    if (!apiSecret || !verifySecret(apiSecret, project.apiSecretHash)) return null;
  }
  // spring 경로(x-api-key): 키 매칭만으로 인증
  return project;
}
