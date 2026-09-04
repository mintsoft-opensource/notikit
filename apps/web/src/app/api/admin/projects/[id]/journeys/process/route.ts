import { ok, fail } from "@/lib/api-response";
import { requireAdmin } from "@/lib/keys";
import { drainJourneys } from "@/lib/journeys";

export const dynamic = "force-dynamic";

/** [Web Admin/Worker] 도래한 저니 실행 진행 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const { id } = await ctx.params;
  return ok(await drainJourneys(id));
}
