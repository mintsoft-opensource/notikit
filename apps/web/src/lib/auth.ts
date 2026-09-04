import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, type Project } from "@/db/schema";
import { verifySecret } from "@/lib/keys";

/**
 * SDK 요청 인증 — 헤더 `api-key` + `api-secret` 둘 다 필수.
 * api-secret 은 sha256 해시로 타이밍 안전 검증. 유효하면 Project, 아니면 null.
 * (api-key 는 클라이언트 노출값이므로 secret 없이는 절대 인증되지 않음)
 */
export async function resolveProject(req: Request): Promise<Project | null> {
  const h = req.headers;
  const apiKey = h.get("api-key");
  const apiSecret = h.get("api-secret");
  if (!apiKey || !apiSecret) return null;

  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  const project = rows[0];
  if (!project) return null;

  if (!verifySecret(apiSecret, project.apiSecretHash)) return null;
  return project;
}
