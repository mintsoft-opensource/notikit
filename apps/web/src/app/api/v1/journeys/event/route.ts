import { getDb } from "@/db/client";
import { resolveProjectPublic } from "@/lib/auth";
import { verifyIdentity } from "@/lib/keys";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { clientKey, principalKey, rateLimitShared } from "@/lib/rate-limit";
import { eventNameSchema, onJourneyEvent } from "@/lib/journey-triggers";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** 한 기기/사람이 분당 보고할 수 있는 트리거 수 — 전환 보고와 같은 이유로 주체별로도 묶는다 */
const PRINCIPAL_LIMIT_PER_MIN = 30;

const schema = z.object({
  event: eventNameSchema,
  external_id: z.string().min(1).max(255),
  identity_hash: z.string().max(128).optional(),
});

/**
 * 저니 트리거 이벤트 (public: api-key + identity).
 *
 * 진입 조건이 이 이름인 저니에 등록하고, 종료 조건이 이 이름인 진행 중 실행을 끝낸다.
 * 둘 다 **멱등**이다: 등록은 (journey, user) 유니크가, 종료는 active 조건이 두 번째 호출을 삼킨다.
 *
 * 이 엔드포인트는 전환 엔드포인트(`/api/v1/events`)의 대체가 아니라 **보완**이다. 전환 기록은
 * 클릭에 귀속될 때만 남아서(귀속할 발송이 없으면 202 로 버려진다) 푸시를 안 누르고 구매한
 * 사람은 종료 조건에 걸리지 않는다. 전환 엔드포인트에 훅 한 줄이 들어가면 이 호출은 선택이 된다.
 *
 * 남의 저니를 지목해 등록·종료시킬 수 있으므로 `identity_hash` 는 enroll 과 같이 항상 필수다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!(await rateLimitShared(clientKey(project.id, "journeys")))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  // 신원 검증이 **먼저**다. 주체별 한도를 먼저 태우면 공개 api-key 만 가진 누구나 가짜 hash 로 남의
  // external_id 버킷을 채워 그 사람의 진짜 저니 이벤트를 전부 429 로 막을 수 있다(v1/events 와 같은 순서).
  // 검증은 HMAC 계산뿐이라 DB 까지 내려가지 않는다.
  if (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc)) {
    return fail("identity_hash invalid or missing", 403);
  }

  // 대상 해석(DB 조회) 전에 주체별 한도를 본다 — 남용이 DB 까지 내려가지 않게
  if (!(await rateLimitShared(principalKey(project.id, "journeys", b.external_id), PRINCIPAL_LIMIT_PER_MIN))) {
    return fail("Rate limit exceeded", 429);
  }

  const r = await onJourneyEvent(getDb(), project.id, b.event, { externalId: b.external_id });
  // 사람을 못 찾아도 404 가 아니다 — SDK 가 identify 전에 이벤트를 보내는 건 정상 흐름이고,
  // 여기서 실패로 돌려주면 앱이 재시도 루프를 돈다. 한 일이 없다는 것만 알린다.
  return ok({ enrolled: r.enrolled.length, exited: r.exited.length, matched: r.userId !== null }, undefined, 202);
}
