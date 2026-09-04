import { getDb } from "@/db/client";
import { pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { verifyIdentity } from "@/lib/keys";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  external_id: z.string().min(1).max(255),
  identity_hash: z.string().max(128).optional(),
  attributes: z
    .record(z.unknown())
    .optional()
    .refine((d) => !d || Buffer.byteLength(JSON.stringify(d), "utf8") <= 8192, "attributes too large (max 8KB)"),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(64).optional(),
});

/** 유저 식별 (public: api-key). identity 검증(HMAC)으로 사칭 방지. */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  if (project.requireIdentityVerification) {
    if (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc)) {
      return fail("identity_hash invalid or missing", 403);
    }
  }

  const db = getDb();
  const rows = await db
    .insert(pushUsers)
    .values({
      projectId: project.id,
      externalId: b.external_id,
      attributes: b.attributes ?? {},
      locale: b.locale,
      timezone: b.timezone,
    })
    .onConflictDoUpdate({
      target: [pushUsers.projectId, pushUsers.externalId],
      set: {
        ...(b.attributes !== undefined ? { attributes: b.attributes } : {}),
        locale: b.locale,
        timezone: b.timezone,
      },
    })
    .returning();

  return ok({ user: rows[0] });
}
