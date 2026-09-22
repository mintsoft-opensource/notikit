import { resolveProjectPrivileged } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { messageSchema, enqueuePush, prepareMessage, MESSAGE_BODY_LIMIT } from "@/lib/messages";
import { ok, fail } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * 푸시 전송 — 수집 즉시 큐잉(로그 생성 후 즉시 ack). 실제 fan-out 은 worker 담당.
 * (수집 ≠ 전송 분리 원칙: API 는 전송에 블로킹하지 않음)
 */
export async function POST(req: Request) {
  const project = await resolveProjectPrivileged(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "send"))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, MESSAGE_BODY_LIMIT);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const prepared = await prepareMessage(project.id, b);
  if ("error" in prepared) return fail(prepared.error, prepared.status);

  const { message, scheduled } = await enqueuePush(project, prepared.message);
  return ok({ message }, { scheduled }, 202);
}
