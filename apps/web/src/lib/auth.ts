import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, type Project } from "@/db/schema";
import { verifySecret } from "@/lib/keys";

async function findProjectByKey(apiKey: string): Promise<Project | null> {
  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  return rows[0] ?? null;
}

/**
 * 공개(client-safe) 엔드포인트 인증 — `api-key` 만으로.
 * 디바이스 등록/identify/토픽구독은 클라이언트 SDK 가 호출하므로 secret 을 노출하지 않는다.
 * api-key 로 할 수 있는 최대치는 "디바이스 등록/구독"뿐(발송 불가) → 노출돼도 피해 제한적.
 */
export async function resolveProjectPublic(req: Request): Promise<Project | null> {
  const apiKey = req.headers.get("api-key");
  if (!apiKey) return null;
  return findProjectByKey(apiKey);
}

/**
 * 권한(server-only) 엔드포인트 인증 — `api-key` + `api-secret` 필수(해시 검증).
 * 발송(messages) 등 민감 작업. secret 은 서버에서만 보관/사용.
 */
export async function resolveProjectPrivileged(req: Request): Promise<Project | null> {
  const apiKey = req.headers.get("api-key");
  const apiSecret = req.headers.get("api-secret");
  if (!apiKey || !apiSecret) return null;
  const project = await findProjectByKey(apiKey);
  if (!project) return null;
  if (!verifySecret(apiSecret, project.apiSecretEnc)) return null;
  return project;
}
