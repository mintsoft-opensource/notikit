import { ok, fail } from "@/lib/api-response";
import { requireAdmin } from "@/lib/keys";
import { retryWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** [Web Admin/Worker] 실패한 웹훅 재시도 (지수 백오프는 cron 주기로) */
export async function POST(req: Request) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  return ok(await retryWebhooks());
}
