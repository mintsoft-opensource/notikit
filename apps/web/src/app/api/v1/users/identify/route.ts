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
  /** 표시·치환용 이름. null 이면 지운다. */
  name: z.string().trim().max(100).nullable().optional(),
  phone: z.string().max(32).optional(),
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
  if (!rateLimit(clientKey(project.id, "identify"))) return fail("Rate limit exceeded", 429);

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

  // 이름을 `name` 대신 예전 방식(attributes.name)으로만 보내는 앱도 이름 칸을 최신으로 맞춘다.
  // 안 맞추면 마이그레이션 때 옮긴 옛 이름이 {{name}}·콘솔 목록에 계속 남는다.
  const attrName = typeof b.attributes?.name === "string" ? b.attributes.name.trim().slice(0, 100) : undefined;
  const name = b.name !== undefined ? b.name || null : attrName !== undefined ? attrName || null : undefined;

  const db = getDb();
  const rows = await db
    .insert(pushUsers)
    .values({
      projectId: project.id,
      externalId: b.external_id,
      name: name ?? null,
      attributes: b.attributes ?? {},
      phone: b.phone,
      locale: b.locale,
      timezone: b.timezone,
    })
    .onConflictDoUpdate({
      target: [pushUsers.projectId, pushUsers.externalId],
      // externalId 항상 포함(빈 set 방지) + attributes 미제공 시 기존 값 유지
      set: {
        externalId: b.external_id,
        ...(name !== undefined ? { name } : {}),
        ...(b.attributes !== undefined ? { attributes: b.attributes } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        locale: b.locale,
        timezone: b.timezone,
      },
    })
    .returning();

  return ok({ user: rows[0] });
}
