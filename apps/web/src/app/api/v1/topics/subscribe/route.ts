import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, topics, subscriptions } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited } from "@/lib/read-json";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  topic: z.string().min(1).max(255),
  token: z.string().min(1).max(4096),
});

/** 디바이스를 토픽에 구독 (없으면 토픽 자동 생성) */
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

  const device = (
    await db
      .select()
      .from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
      .limit(1)
  )[0];
  if (!device) return fail("Device not found — register it first", 404);

  const topic = (
    await db
      .insert(topics)
      .values({ projectId: project.id, name: b.topic })
      .onConflictDoUpdate({ target: [topics.projectId, topics.name], set: { name: b.topic } })
      .returning()
  )[0];

  await db
    .insert(subscriptions)
    .values({ topicId: topic.id, deviceId: device.id })
    .onConflictDoNothing({ target: [subscriptions.topicId, subscriptions.deviceId] });

  return ok({ subscribed: true, topic: topic.name });
}
