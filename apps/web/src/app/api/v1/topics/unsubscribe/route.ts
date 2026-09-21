import { getDb } from "@/db/client";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import {
  targetSchema,
  verifyTarget,
  resolveDevices,
  resolveWritableTopic,
  unsubscribeDevices,
  isFailure,
} from "@/lib/topic-membership";

export const dynamic = "force-dynamic";

/**
 * 토픽 구독 해지 (public: api-key). token 이면 기기 하나, external_id 면 그 사람의 활성 기기 전부.
 *
 * 구독과 달리 토픽을 만들지 않는다 — 없는 토픽에서 빼 달라는 요청은 오타일 가능성이 높고,
 * 여기서 만들면 "해지했더니 토픽이 생겼다"가 된다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "subscribe"))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = targetSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;
  const denied = verifyTarget(b, project.apiSecretEnc);
  if (denied) return fail(denied.error, denied.status);

  const db = getDb();

  const target = await resolveDevices(db, project.id, b);
  if (isFailure(target)) return fail(target.error, target.status);

  const topic = await resolveWritableTopic(db, project.id, b.topic, false);
  if (isFailure(topic)) return fail(topic.error, topic.status);

  const removed = await unsubscribeDevices(db, topic.topicId, target.deviceIds);
  return ok({ unsubscribed: true, topic: b.topic, devices: target.deviceIds.length, removed });
}
