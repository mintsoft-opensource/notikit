import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { verifyIdentity } from "@/lib/keys";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  external_id: z.string().max(255).optional(),
  identity_hash: z.string().max(128).optional(),
  token: z.string().max(4096).optional(),
  reason: z.enum(["opt_out", "bounced", "complaint", "manual"]).default("opt_out"),
});

/** 수신거부(opt-out) 등록 — 이후 발송에서 자동 제외 (public: api-key) */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "suppressions"))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;
  if (!b.external_id && !b.token) return fail("external_id or token required", 422);

  // external_id 수신거부는 **타 유저의 수신을 영구히 끊는** 동작이다. 공개 api-key 는
  // SDK 에 실려 나가므로 비밀이 아니고, external_id 가 순번·이메일이면 열거가 가능하다.
  // 그래서 inbox·journeys/enroll 과 같이 프로젝트 플래그와 무관하게 항상 증명을 요구한다.
  // token 변형은 공격자가 실제 디바이스 토큰을 알아야 하므로 그대로 둔다.
  if (b.external_id && (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc))) {
    return fail("identity_hash invalid or missing for external_id suppression", 403);
  }

  const db = getDb();
  const row = (
    await db.insert(suppressions).values({ projectId: project.id, externalId: b.external_id, token: b.token, reason: b.reason }).returning()
  )[0];
  return ok({ suppression: row }, undefined, 201);
}
