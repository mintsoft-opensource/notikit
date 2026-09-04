import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, type Project } from "@/db/schema";

/**
 * SDK 요청 인증 — api-key/api-secret (v1) 또는 X-Project-Id/X-Api-Key (spring 호환).
 * 유효하면 Project 반환, 아니면 null.
 */
export async function resolveProject(req: Request): Promise<Project | null> {
  const h = req.headers;
  const apiKey = h.get("api-key") ?? h.get("x-api-key");
  const apiSecret = h.get("api-secret");

  if (!apiKey) return null;

  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  const project = rows[0];
  if (!project) return null;

  // v1: secret 검증. spring 호환(X-Api-Key)은 key 자체가 secret 역할.
  if (apiSecret && project.apiSecret !== apiSecret) return null;

  return project;
}
