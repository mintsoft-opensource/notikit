import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { verifyIdentity } from "@/lib/keys";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  journey: z.string().min(1).max(120),
  external_id: z.string().min(1).max(255),
  identity_hash: z.string().max(128).optional(),
});

/** 유저를 저니에 등록 (public: api-key + identity) */
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

  if (project.requireIdentityVerification && (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc))) {
    return fail("identity_hash invalid or missing", 403);
  }

  const db = getDb();
  const journey = (
    await db.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.projectId, project.id), eq(journeys.name, b.journey))).limit(1)
  )[0];
  if (!journey) return fail("Journey not found", 404);

  const user = (
    await db.insert(pushUsers).values({ projectId: project.id, externalId: b.external_id })
      .onConflictDoUpdate({ target: [pushUsers.projectId, pushUsers.externalId], set: { externalId: b.external_id } })
      .returning({ id: pushUsers.id })
  )[0];

  const run = (
    await db.insert(journeyRuns).values({ journeyId: journey.id, projectId: project.id, userId: user.id, currentStep: 0, status: "active", nextRunAt: new Date() }).returning({ id: journeyRuns.id })
  )[0];

  return ok({ enrolled: true, run_id: run.id }, undefined, 201);
}
