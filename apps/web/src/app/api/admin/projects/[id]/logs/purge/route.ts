import { and, eq, gte, inArray, lt, or, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, webhookDeliveries, webhooks } from "@/db/schema";
import { fail, ok } from "@/lib/api-response";
import { checkOrigin, requireProject } from "@/lib/authz";
import { MAX_ATTEMPTS } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/**
 * 푸시 로그 리텐션 purge.
 *
 * 로그는 코어 테이블과 **같은 DB** 에 있다. 단일 박스 온프렘에서 이게 무한히 자라면
 * 디스크가 차고, 그 순간 Postgres 가 멈추면서 **로그 때문에 푸시 전체가 죽는다.**
 * 고객사 박스에는 우리가 들어갈 수 없으므로 이건 사고가 아니라 시한장치다.
 *
 * 끝나지 않은 발송은 지우지 않는다 — `queued`/`scheduled`/`processing` 은 워커가
 * 아직 손댈 수 있고, 지우면 예약 발송이 조용히 사라진다.
 *
 * `push_clicks` 는 FK cascade 로 함께 지워진다.
 *
 * 웹훅 배달 이력(`webhook_deliveries`)도 같은 창으로 지운다. 이 테이블은 발송 한 건에
 * 엔드포인트 수만큼 쌓이고 push_logs 와 FK 로 묶여 있지 않아, 로그만 지우면 **여기만 무한히 자란다** —
 * 디스크를 채우는 경로가 그대로 하나 남는 셈이다.
 */

/** 지워도 되는 상태 — 워커가 더 이상 건드리지 않는 것만 */
const TERMINAL = ["completed", "failed", "logged"] as const;

/** 한 번에 지우는 최대 행 수. 큰 테이블에서 단일 DELETE 는 락과 WAL 을 오래 잡는다. */
const BATCH = 5_000;
/** 한 호출에서 도는 최대 배치. 워커 tick 을 독점하지 않게 끊는다. */
const MAX_BATCHES = 20;

/**
 * 지워도 되는 웹훅 배달 — 배달됐거나, 재시도 한도를 다 쓴 것만.
 * `pending`/`retrying` 과 아직 한도가 남은 실패는 스윕이 다시 집어 갈 행이라 남긴다
 * (창을 넘긴 행이라도 지우면 그 배달은 시도해 보지도 못하고 사라진다).
 */
function settledDelivery() {
  return or(eq(webhookDeliveries.status, "delivered"), gte(webhookDeliveries.attempts, MAX_ATTEMPTS));
}

/**
 * id 를 배치로 골라 지우는 루프. DELETE 에 LIMIT 을 걸 수 없어 고른 집합만 지운다.
 * `done=false` 면 이번 호출에서 다 못 비웠다는 뜻 — 다음 tick 이 이어서 지운다.
 */
async function purgeBatches(
  pickIds: () => Promise<{ id: string }[]>,
  removeIds: (ids: string[]) => Promise<void>
): Promise<{ removed: number; done: boolean }> {
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await pickIds();
    if (batch.length === 0) return { removed, done: true };
    await removeIds(batch.map((r) => r.id));
    removed += batch.length;
    // 배치가 가득 찼다면 더 남았을 수 있다
    if (batch.length < BATCH) return { removed, done: true };
  }
  return { removed, done: false };
}

function retentionDays(): number {
  const raw = Number(process.env.LOG_RETENTION_DAYS);
  // 0 이나 음수는 "끄기"가 아니라 설정 실수일 가능성이 높다 — 전체 삭제를 막는다.
  if (!Number.isFinite(raw) || raw < 1) return 0;
  return Math.floor(raw);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const days = retentionDays();
  // 미설정이면 아무것도 지우지 않는다. 로그 보존은 고객이 정할 일이다.
  if (days === 0) return ok({ purged: 0, purgedWebhookDeliveries: 0, retentionDays: null, done: true });

  const cutoff = new Date(Date.now() - days * 86_400_000);
  const db = getDb();

  const logs = await purgeBatches(
    () =>
      db
        .select({ id: pushLogs.id })
        .from(pushLogs)
        .where(
          and(
            eq(pushLogs.projectId, id),
            lt(pushLogs.createdAt, cutoff),
            inArray(pushLogs.status, TERMINAL as unknown as string[])
          )
        )
        .limit(BATCH),
    async (ids) => {
      await db.delete(pushLogs).where(inArray(pushLogs.id, ids));
    }
  );

  // 배달 이력은 프로젝트 칼럼이 없어 웹훅을 거쳐 이 프로젝트 것만 고른다
  const deliveries = await purgeBatches(
    () =>
      db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
        .where(and(eq(webhooks.projectId, id), lt(webhookDeliveries.createdAt, cutoff), settledDelivery()))
        .limit(BATCH),
    async (ids) => {
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, ids));
    }
  );

  const purged = logs.removed;
  const done = logs.done && deliveries.done;
  if (purged > 0 || deliveries.removed > 0) {
    console.log(
      `[purge] project=${id} logs=${purged} deliveries=${deliveries.removed} olderThan=${days}d done=${done}`
    );
  }

  return ok({
    purged,
    purgedWebhookDeliveries: deliveries.removed,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    done,
  });
}

/** 현재 리텐션 설정과 대상 건수 — 인수인계 점검용 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const days = retentionDays();
  const db = getDb();

  const total = await db.execute(
    raw`select count(*)::int as n from push_logs where project_id = ${id}`
  );
  const expired = days
    ? await db.execute(
        raw`select count(*)::int as n from push_logs
             where project_id = ${id}
               and created_at < now() - (${days} || ' days')::interval
               and status in ('completed','failed','logged')`
      )
    : [{ n: 0 }];

  const expiredDeliveries = days
    ? await db.execute(
        raw`select count(*)::int as n from webhook_deliveries d
             join webhooks w on w.id = d.webhook_id
             where w.project_id = ${id}
               and d.created_at < now() - (${days} || ' days')::interval
               and (d.status = 'delivered' or d.attempts >= ${MAX_ATTEMPTS})`
      )
    : [{ n: 0 }];

  return ok({
    retentionDays: days || null,
    total: (total as unknown as { n: number }[])[0]?.n ?? 0,
    purgeable: (expired as unknown as { n: number }[])[0]?.n ?? 0,
    webhookDeliveriesPurgeable: (expiredDeliveries as unknown as { n: number }[])[0]?.n ?? 0,
  });
}
