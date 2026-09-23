import { getDb } from "@/db/client";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { clientKey, rateLimitShared } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import {
  targetSchema,
  verifyTarget,
  resolveDevices,
  resolveWritableTopic,
  subscribeDevices,
  isFailure,
} from "@/lib/topic-membership";

export const dynamic = "force-dynamic";

/** 토픽 구독 (public: api-key). token 이면 기기 하나, external_id 면 그 사람의 활성 기기 전부. */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!await rateLimitShared(clientKey(project.id, "subscribe"))) return fail("Rate limit exceeded", 429);

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

  // 토픽 자동 생성은 기기를 확인한 뒤에 한다. 먼저 만들면 404 로 끝난 요청이
  // 빈 토픽을 남긴다.
  const topic = await resolveWritableTopic(db, project.id, b.topic, true);
  if (isFailure(topic)) return fail(topic.error, topic.status);

  const added = await subscribeDevices(db, topic.topicId, target.deviceIds);
  return ok({ subscribed: true, topic: b.topic, devices: target.deviceIds.length, added });
}
