import { getDb } from "@/db/client";
import { devices, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { verifyIdentity } from "@/lib/keys";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["android", "ios", "web", "webview", "electron", "flutter", "react-native"]),
  external_id: z.string().max(255).optional(),
  identity_hash: z.string().max(128).optional(),
  app_version: z.string().max(64).optional(),
  os_version: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(64).optional(),
  country: z.string().max(8).optional(),
});

/** 디바이스/토큰 등록·업서트 (public: api-key). external_id 바인딩은 identity 검증 필요. */
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

  // external_id 바인딩 시 identity 검증(HMAC) — 타 유저 사칭 방지
  if (b.external_id && project.requireIdentityVerification) {
    if (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc)) {
      return fail("identity_hash invalid or missing for external_id binding", 403);
    }
  }

  const db = getDb();

  let userId: string | null = null;
  if (b.external_id) {
    const u = await db
      .insert(pushUsers)
      .values({ projectId: project.id, externalId: b.external_id, locale: b.locale, timezone: b.timezone })
      .onConflictDoUpdate({
        target: [pushUsers.projectId, pushUsers.externalId],
        // externalId 항상 포함 → set 이 비지 않음(drizzle "No values to set" 방지)
        set: { externalId: b.external_id, locale: b.locale, timezone: b.timezone },
      })
      .returning();
    userId = u[0]?.id ?? null;
  }

  const rows = await db
    .insert(devices)
    .values({
      projectId: project.id,
      token: b.token,
      platform: b.platform,
      userId,
      appVersion: b.app_version,
      osVersion: b.os_version,
      locale: b.locale,
      timezone: b.timezone,
      country: b.country,
      isActive: true,
      lastActiveAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [devices.projectId, devices.token],
      set: {
        platform: b.platform,
        ...(b.external_id ? { userId } : {}),
        appVersion: b.app_version,
        osVersion: b.os_version,
        locale: b.locale,
        timezone: b.timezone,
        country: b.country,
        isActive: true,
        lastActiveAt: new Date(),
      },
    })
    .returning();

  return ok({ device: rows[0] }, undefined, 201);
}
