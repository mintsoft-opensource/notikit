import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { recordAccess } from "@/lib/device-activity";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({ token: z.string().min(1).max(4096) });

/**
 * 앱 열림 보고 (public: api-key).
 *
 * 등록(POST /devices)은 토큰·플랫폼·버전을 다 실어보내는 무거운 호출이라 앱을 열 때마다
 * 부르기엔 과하다. 이 엔드포인트는 토큰 하나만 받아 접속만 기록한다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "ping"), 20_000)) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const db = getDb();
  const device = (
    await db
      .select({ id: devices.id, userId: devices.userId, platform: devices.platform })
      .from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, parsed.data.token)))
      .limit(1)
  )[0];
  if (!device) return fail("Device not found", 404);

  await db
    .update(devices)
    .set({ lastActiveAt: new Date() })
    .where(and(eq(devices.projectId, project.id), eq(devices.id, device.id)));
  await recordAccess(db, project.id, device);

  return ok({ recorded: true }, undefined, 202);
}
