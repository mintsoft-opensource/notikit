import { and, eq, inArray, lt, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { fail, ok } from "@/lib/api-response";
import { checkOrigin, requireProject } from "@/lib/authz";

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
 */

/** 지워도 되는 상태 — 워커가 더 이상 건드리지 않는 것만 */
const TERMINAL = ["completed", "failed", "logged"] as const;

/** 한 번에 지우는 최대 행 수. 큰 테이블에서 단일 DELETE 는 락과 WAL 을 오래 잡는다. */
const BATCH = 5_000;
/** 한 호출에서 도는 최대 배치. 워커 tick 을 독점하지 않게 끊는다. */
const MAX_BATCHES = 20;

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
  if (days === 0) return ok({ purged: 0, retentionDays: null, done: true });

  const cutoff = new Date(Date.now() - days * 86_400_000);
  const db = getDb();

  let purged = 0;
  let done = true;
  for (let i = 0; i < MAX_BATCHES; i++) {
    // id 를 먼저 고르고 그 집합만 지운다 — DELETE 에 직접 LIMIT 을 걸 수 없다.
    const batch = await db
      .select({ id: pushLogs.id })
      .from(pushLogs)
      .where(
        and(
          eq(pushLogs.projectId, id),
          lt(pushLogs.createdAt, cutoff),
          inArray(pushLogs.status, TERMINAL as unknown as string[])
        )
      )
      .limit(BATCH);

    if (batch.length === 0) break;

    await db.delete(pushLogs).where(inArray(pushLogs.id, batch.map((r) => r.id)));
    purged += batch.length;

    // 배치가 가득 찼다면 더 남았을 수 있다
    if (batch.length < BATCH) break;
    if (i === MAX_BATCHES - 1) done = false;
  }

  if (purged > 0) {
    console.log(`[purge] project=${id} removed=${purged} olderThan=${days}d done=${done}`);
  }

  return ok({ purged, retentionDays: days, cutoff: cutoff.toISOString(), done });
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

  return ok({
    retentionDays: days || null,
    total: (total as unknown as { n: number }[])[0]?.n ?? 0,
    purgeable: (expired as unknown as { n: number }[])[0]?.n ?? 0,
  });
}
