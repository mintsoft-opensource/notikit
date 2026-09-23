import { getDb } from "@/db/client";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit } from "@/lib/rate-limit";
import { messageSchema, targetError, MESSAGE_BODY_LIMIT } from "@/lib/messages";
import { countAudience } from "@/lib/audience-count";

export const dynamic = "force-dynamic";

// 발송과 같은 대상 필드만 받는다 — 규칙이 갈라지면 "추정 N명"과 실제 발송 대상이 어긋난다
const estimateSchema = messageSchema.pick({ type: true, target: true, targets: true });

/**
 * [Web Admin] 발송 전 도달 인원 추정 — 사용자·기기·플랫폼별 기기 수.
 *
 * 실제 발송이 클릭률 분모로 쓰는 `countAudience` 를 그대로 쓴다(활성 기기만, 수신거부 제외).
 * 조회지만 POST 인 이유: multi 의 받는 사람 목록(최대 1000명)이 쿼리스트링에 들어가지 않는다.
 * 콘솔이 대상을 바꿀 때마다 부르므로 발송과 별도 버킷으로 스로틀한다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);
  if (!rateLimit(`admin:estimate:${id}`)) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, MESSAGE_BODY_LIMIT);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = estimateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;
  const err = targetError(b);
  if (err) return fail(err, 422);

  const audience = await countAudience(getDb(), {
    projectId: id,
    type: b.type,
    target: b.type === "multi" ? null : (b.target ?? null),
    targets: b.type === "multi" ? [...new Set(b.targets)] : null,
  });
  return ok(audience);
}
