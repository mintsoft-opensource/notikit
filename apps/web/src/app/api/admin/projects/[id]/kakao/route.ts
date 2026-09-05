import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { encryptSecret } from "@/lib/keys";
import { requireProject, checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { parseKakaoConfig } from "@/lib/kakao";
import { assertSafeWebhookUrl } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** [Web Admin] 카카오 알림톡 설정 업로드 (웹) — 검증 후 암호화 저장 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }

  let config;
  try {
    const raw = (payload as { config?: unknown })?.config ?? payload;
    config = parseKakaoConfig(raw);
    await assertSafeWebhookUrl(config.provider_url); // SSRF 방어 (provider_url)
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid config", 422);
  }

  const db = getDb();
  const updated = await db
    .update(projects)
    .set({ kakaoConfigEnc: encryptSecret(JSON.stringify(config)) })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  if (updated.length === 0) return fail("Project not found", 404);
  return ok({ configured: true });
}
