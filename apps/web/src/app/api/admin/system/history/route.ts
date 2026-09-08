import { ok, fail } from "@/lib/api-response";
import { requireAuth } from "@/lib/authz";
import { readHistory, listInstances, INSTANCE_ID } from "@/lib/metrics-store";

export const dynamic = "force-dynamic";

/** 범위별 윈도우와 버킷 — 어떤 범위든 포인트 수가 일정하게 유지된다(60~168개) */
const RANGES = {
  "1h": { ms: 3600_000, bucketSec: 60 },
  "24h": { ms: 86400_000, bucketSec: 600 },
  "7d": { ms: 7 * 86400_000, bucketSec: 3600 },
} as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** [Web Admin] 저장된 호스트 메트릭 이력 — 호스트 지표이므로 owner/admin 만 */
export async function GET(req: Request) {
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range");
  const range: RangeKey = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : "1h";
  // 여러 인스턴스의 값을 한 선으로 이으면 오해를 부른다 — 항상 하나만, 기본은 요청을 처리한 인스턴스
  const instances = await listInstances();
  const requested = url.searchParams.get("instance");
  const instance = requested && instances.some((i) => i.instanceId === requested) ? requested : INSTANCE_ID;

  const { ms, bucketSec } = RANGES[range];
  const points = await readHistory(ms, instance, bucketSec);
  return ok({ range, instance, instanceId: INSTANCE_ID, instances, points });
}
