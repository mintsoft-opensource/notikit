import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  external_id: z.string().max(255).optional(),
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

  const db = getDb();
  const row = (
    await db.insert(suppressions).values({ projectId: project.id, externalId: b.external_id, token: b.token, reason: b.reason }).returning()
  )[0];
  return ok({ suppression: row }, undefined, 201);
}
