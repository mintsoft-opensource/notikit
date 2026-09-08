import { ok, fail } from "@/lib/api-response";
import { requireAuth } from "@/lib/authz";
import { readHistory, listInstances, INSTANCE_ID } from "@/lib/metrics-store";

export const dynamic = "force-dynamic";

const RANGES = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000 } as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** [Web Admin] 저장된 호스트 메트릭 이력 — 호스트 지표이므로 owner/admin 만 */
export async function GET(req: Request) {
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "1h";
  const instance = url.searchParams.get("instance") ?? undefined;

  const [points, instances] = await Promise.all([readHistory(RANGES[range], instance), listInstances()]);
  return ok({ range, instanceId: INSTANCE_ID, instances, points });
}
