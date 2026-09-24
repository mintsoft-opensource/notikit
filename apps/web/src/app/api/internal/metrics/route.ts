import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ok, fail } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";
import { errorMessage, getLogCounters, INSTANCE_ID, log } from "@/lib/logger";
import { getRateLimitHealth } from "@/lib/rate-limit";
import { readSharedCounters } from "@/lib/redis";
import { getWebhookHealth } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** 기본 집계 창 — "지금 문제가 있나"를 보는 길이. */
const DEFAULT_WINDOW_MIN = 60;
const MAX_WINDOW_MIN = 24 * 60;
/** 사유는 상위 N 개만 — 꼬리는 운영 판단을 돕지 않고 응답만 키운다. */
const TOP_REASONS = 20;

/** Redis 에 합산해 둔 클러스터 카운터 — 프로세스 값과 짝을 이루는 이름만 읽는다. */
const SHARED_COUNTER_NAMES = ["ratelimit.fallback", "webhook.dead_letter"] as const;

type SendStats = {
  windowMinutes: number;
  /** 이 창에 만들어진 발송(로그) 수 */
  logs: number;
  /** 토큰 단위로 처리된 수신자 수 = 성공 + 실패 */
  processed: number;
  delivered: number;
  failed: number;
  /** 한도를 다 쓰고 `failed` 로 닫힌 발송 수 (사유 문자열은 자유 텍스트라 싣지 않는다) */
  abandonedLogs: number;
  /** FCM 오류 코드별 실패 건수 — "실패 12건"만으로는 쿼터와 죽은 토큰을 구분할 수 없다 */
  failuresByReason: Record<string, number>;
};

/**
 * 발송 통계는 **DB 에서 읽는다.** 프로세스 카운터로 세면 replica·워커가 여럿일 때
 * 각자 자기 조각만 알고, 재시작하면 0 으로 돌아간다. push_logs 는 이미 성공/실패와
 * 토큰별 실패 사유(`delivery_errors`)를 들고 있으므로 그게 유일한 진실이다.
 */
async function sendStats(windowMinutes: number): Promise<SendStats> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const db = getDb();

  const totals = (await db.execute(sql`
    select
      count(*)::int                                            as logs,
      coalesce(sum(success_count), 0)::int                     as delivered,
      coalesce(sum(failure_count), 0)::int                     as failed,
      count(*) filter (where status = 'failed')::int           as abandoned
    from push_logs
    where created_at >= ${since}::timestamptz
  `)) as unknown as Array<{ logs: number; delivered: number; failed: number; abandoned: number }>;

  // delivery_errors 의 키는 FCM 오류 코드다(messaging/quota-exceeded 등) — 카디널리티가 낮고
  // 사용자 데이터가 섞이지 않는다. failure_reason(예외 메시지)은 자유 텍스트라 쓰지 않는다.
  const reasons = (await db.execute(sql`
    select e.key as reason, sum(e.value::int)::int as count
    from push_logs l, lateral jsonb_each_text(coalesce(l.delivery_errors, '{}'::jsonb)) e
    where l.created_at >= ${since}::timestamptz
    group by 1
    order by 2 desc
    limit ${TOP_REASONS}
  `)) as unknown as Array<{ reason: string; count: number }>;

  const t = totals[0] ?? { logs: 0, delivered: 0, failed: 0, abandoned: 0 };
  return {
    windowMinutes,
    logs: t.logs,
    processed: t.delivered + t.failed,
    delivered: t.delivered,
    failed: t.failed,
    abandonedLogs: t.abandoned,
    failuresByReason: Object.fromEntries(reasons.map((r) => [r.reason, r.count])),
  };
}

/**
 * [Internal/Operator] 운영이 실제로 보는 숫자 한 장.
 *
 * 리뷰마다 같은 지적이 나왔다 — 조용한 실패(인메모리 한도 폴백, 포기한 웹훅, 사유 없는 발송 실패)가
 * 로그에만 흩어져 있어 아무도 모른다. 여기 네 가지를 모은다:
 * 발송 처리량 · 사유별 실패 · 공유 한도 폴백 · 웹훅 데드레터.
 *
 * **숫자의 범위를 분명히 표시한다.** `process` 는 이 인스턴스의 조각이고(replica 가 둘이면
 * 합이 아니다), `shared` 는 Redis 에 모은 클러스터 합계다(Redis 가 없으면 null).
 * `sends` 는 DB 에서 읽으므로 인스턴스와 무관하다.
 *
 * 인증: `ADMIN_TOKEN`(서버-투-서버) 또는 콘솔 superadmin 세션.
 */
export async function GET(req: Request) {
  const ctx = await getAuthContext(req);
  if (!ctx?.superadmin) return fail("Unauthorized", 401);

  const raw = Number(new URL(req.url).searchParams.get("window_min"));
  const windowMinutes = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_WINDOW_MIN) : DEFAULT_WINDOW_MIN;

  try {
    const [sends, shared] = await Promise.all([
      sendStats(windowMinutes),
      readSharedCounters(SHARED_COUNTER_NAMES),
    ]);
    const rl = getRateLimitHealth();

    return ok({
      instance: INSTANCE_ID,
      sends,
      /** 클러스터 합계. null 이면 Redis 가 없거나 지금 응답하지 않는다는 뜻 — 그때는 process 만 본다. */
      shared,
      process: {
        scope: "process" as const,
        rateLimit: {
          shared: rl.enabled,
          connected: rl.connected,
          /** 이 값이 늘면 한도가 replica 배수로 느슨해지고 있다 */
          fallbacks: rl.fallbacks,
          /** 차단기가 열려 예산조차 물지 않은 횟수 */
          shortCircuits: rl.shortCircuits,
          breakerMs: rl.breakerMs,
          timeouts: rl.timeouts,
          degradedSince: rl.degradedSince,
          trackedKeys: rl.trackedKeys,
        },
        webhooks: getWebhookHealth(),
        counters: getLogCounters(),
      },
    });
  } catch (e) {
    log.error("metrics.failed", { reason: errorMessage(e) });
    return fail(errorMessage(e), 500);
  }
}
