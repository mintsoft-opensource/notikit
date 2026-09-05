import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { retryWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** [Web Admin/Worker] 이 프로젝트의 실패 웹훅 재시도 (프로젝트 스코프) */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  return ok(await retryWebhooks(id));
}
