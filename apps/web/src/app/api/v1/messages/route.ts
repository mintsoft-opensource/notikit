import { resolveProjectPrivileged } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import {
  messageSchema,
  enqueuePush,
  prepareMessage,
  MESSAGE_BODY_LIMIT,
  parseIdempotencyKey,
  findIdempotent,
  messageDto,
} from "@/lib/messages";
import { ok, fail } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * 푸시 전송 — 수집 즉시 큐잉(로그 생성 후 즉시 ack). 실제 fan-out 은 worker 담당.
 * (수집 ≠ 전송 분리 원칙: API 는 전송에 블로킹하지 않음)
 *
 * `Idempotency-Key` 헤더가 있으면 같은 키의 재요청에 처음 큐잉한 발송을 200 으로 돌려준다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPrivileged(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "send"))) return fail("Rate limit exceeded", 429);

  const idem = parseIdempotencyKey(req);
  if ("error" in idem) return fail(idem.error, 400);
  // 재시도는 본문 검증보다 먼저 — 처음 요청이 통과했다면 그 결과가 답이다
  if (idem.key) {
    const existing = await findIdempotent(project.id, idem.key);
    if (existing) {
      return ok({ message: messageDto(existing) }, { scheduled: existing.status === "scheduled", idempotent_replay: true }, 200);
    }
  }

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, MESSAGE_BODY_LIMIT);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  // 테스트 표시는 콘솔 전용 — 서버 키로 보낸 발송이 스스로 "테스트"를 달아 통계에서 빠지는 걸 막는다
  const { test: _test, ...b } = parsed.data;

  const prepared = await prepareMessage(project.id, b);
  if ("error" in prepared) return fail(prepared.error, prepared.status);

  const { message, scheduled, replay } = await enqueuePush(project, prepared.message, {
    sentBy: "api",
    idempotencyKey: idem.key,
  });
  return ok(
    { message: messageDto(message) },
    replay ? { scheduled, idempotent_replay: true } : { scheduled },
    replay ? 200 : 202
  );
}
