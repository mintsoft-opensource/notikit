import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { drainQueue } from "@/lib/push-processor";
import { acquireInflight, releaseInflight } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * [Web Admin/Worker] 프로젝트의 큐잉된 푸시를 처리(실제 FCM 발송).
 * cron 또는 worker 컨테이너가 주기적으로 호출. (수집≠전송 분리)
 *
 * 같은 프로젝트의 드레인은 한 번에 하나만 돌린다. 대형 발송이 tick 보다 오래 걸리면 워커가
 * 계속 덧쌓고, 뒤따르는 호출들은 이미 클레임된 행을 찾느라 DB 만 때린다. 겹친 호출은
 * 에러가 아니라 `skipped` 로 돌려준다 — 워커·버튼 어느 쪽에도 실패로 보이면 안 된다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const slot = `queue:${id}`;
  if (!acquireInflight(slot, 1)) return ok({ processed: 0, skipped: true });
  try {
    const result = await drainQueue(id);
    return ok(result);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Processing failed", 500);
  } finally {
    releaseInflight(slot);
  }
}
