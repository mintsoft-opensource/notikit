import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { runDueSchedules } from "@/lib/schedules";

export const dynamic = "force-dynamic";

/** [Web Admin/Worker] 도래한 반복 예약을 큐에 넣는다 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  return ok(await runDueSchedules(id));
}
