import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { drainQueue } from "@/lib/push-processor";

export const dynamic = "force-dynamic";

/**
 * [Web Admin/Worker] 프로젝트의 큐잉된 푸시를 처리(실제 FCM 발송).
 * cron 또는 worker 컨테이너가 주기적으로 호출. (수집≠전송 분리)
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  try {
    const result = await drainQueue(id);
    return ok(result);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Processing failed", 500);
  }
}
