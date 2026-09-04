import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAdmin, encryptSecret } from "@/lib/keys";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { parseServiceAccount } from "@/lib/firebase-credentials";

export const dynamic = "force-dynamic";

/**
 * [Web Admin] 프로젝트에 Firebase 서비스 계정 JSON 업로드 (웹 대시보드).
 * 검증 → AES-256-GCM 암호화 → firebase_credentials_enc 저장. 원문은 저장/반환하지 않음.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const { id } = await ctx.params;

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, 64_000); // 서비스 계정 JSON 여유
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }

  let sa;
  try {
    // { credentials: {...} } 또는 서비스계정 JSON 자체 허용
    const raw = (payload as { credentials?: unknown })?.credentials ?? payload;
    sa = parseServiceAccount(raw);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid service account", 422);
  }

  const db = getDb();
  const updated = await db
    .update(projects)
    .set({ firebaseCredentialsEnc: encryptSecret(JSON.stringify(sa)) })
    .where(eq(projects.id, id))
    .returning({ id: projects.id, name: projects.name });

  if (updated.length === 0) return fail("Project not found", 404);

  return ok({ project: updated[0], firebase_project_id: sa.project_id, configured: true });
}
