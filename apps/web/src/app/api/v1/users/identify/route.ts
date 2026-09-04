import { getDb } from "@/db/client";
import { pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited } from "@/lib/read-json";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  external_id: z.string().min(1).max(255),
  attributes: z
    .record(z.unknown())
    .optional()
    .refine((d) => !d || Buffer.byteLength(JSON.stringify(d), "utf8") <= 8192, "attributes too large (max 8KB)"),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(64).optional(),
});

/** 유저 식별 (identity 레이어) — 외부 유저ID 업서트 + 속성 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch {
    return fail("Payload too large", 413);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

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
      // attributes 미제공 시 기존 값 유지(빈 객체로 덮어쓰지 않음)
      set: {
        ...(b.attributes !== undefined ? { attributes: b.attributes } : {}),
        locale: b.locale,
        timezone: b.timezone,
      },
    })
    .returning();

  return ok({ user: rows[0] });
}
