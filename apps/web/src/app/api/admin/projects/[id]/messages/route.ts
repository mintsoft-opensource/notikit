import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit } from "@/lib/rate-limit";
import { messageSchema, enqueuePush, prepareMessage, MESSAGE_BODY_LIMIT } from "@/lib/messages";

export const dynamic = "force-dynamic";

/**
 * [Web Admin] 콘솔에서 푸시 발송 — admin 세션/역할로 인가(api-secret 불필요).
 * 프로젝트 org 스코프 + write 역할 필요. 실제 fan-out 은 worker/process-queue.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const { id } = await ctx.params;
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  // SDK(v1)와 동일한 스로틀 — 키는 분리해 콘솔 발송이 SDK 쿼터를 잠식하지 않게 함
  if (!rateLimit(`admin:proj:${id}`)) return fail("Rate limit exceeded", 429);

  const project = (
    await getDb()
      .select({ id: projects.id, quietStartHour: projects.quietStartHour, quietEndHour: projects.quietEndHour })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  if (!project) return fail("Project not found", 404);

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
