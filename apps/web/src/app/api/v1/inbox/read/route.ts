import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notifications, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  external_id: z.string().max(255),
  notification_id: z.string().uuid().optional(), // 없으면 전체 읽음
});

/** 인박스 읽음 처리 (특정 알림 또는 전체) */
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

  const db = getDb();
  const user = (
    await db.select({ id: pushUsers.id }).from(pushUsers)
      .where(and(eq(pushUsers.projectId, project.id), eq(pushUsers.externalId, b.external_id))).limit(1)
  )[0];
  if (!user) return fail("User not found", 404);

  const now = new Date();
  if (b.notification_id) {
    await db.update(notifications).set({ readAt: now })
      .where(and(eq(notifications.id, b.notification_id), eq(notifications.userId, user.id)));
  } else {
    await db.update(notifications).set({ readAt: now })
      .where(and(eq(notifications.projectId, project.id), eq(notifications.userId, user.id)));
  }
  return ok({ read: true });
}
