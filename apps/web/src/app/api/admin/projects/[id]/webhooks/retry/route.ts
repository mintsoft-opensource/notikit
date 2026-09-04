import { ok, fail } from "@/lib/api-response";
import { requireAdmin } from "@/lib/keys";
import { retryWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** [Web Admin/Worker] 이 프로젝트의 실패 웹훅 재시도 (프로젝트 스코프) */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const { id } = await ctx.params;
  return ok(await retryWebhooks(id));
}
