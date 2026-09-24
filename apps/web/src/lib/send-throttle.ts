/**
 * 발송 속도 제한 — 프로젝트당 "분당 최대 N건".
 *
 * 예산은 DB(push_rate_counters)에 둔다. 워커가 여러 대일 수 있어 프로세스 메모리에 세면
 * 창마다 워커 수만큼 예산이 늘어난다.
 *
 * 소진했을 때 **루프 안에서 기다리지 않는다** — 5분(STALE_MS)을 넘기면 다른 워커가 같은 로그를
 * 재클레임해 보낸 페이지를 또 보낸다. 대신 다음 창 시각을 진행 상태에 적고 로그를 반납한다.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { pushRateCounters } from "@/db/schema";
import type { Db } from "@/lib/audience-count";

export const RATE_WINDOW_MS = 60_000;
/** 지난 창 보존 — 판정에 쓰이지 않는 행을 남겨 두면 테이블이 무한히 자란다 */
const RATE_RETENTION_MS = 5 * RATE_WINDOW_MS;

/** 이 시각이 속한 1분 창의 시작 */
export function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
}

/** 다음 창이 열리는 시각 — 예산을 소진했을 때 다시 깨어날 시각이다 */
export function nextWindow(now: Date): Date {
  return new Date(windowStart(now).getTime() + RATE_WINDOW_MS);
}

/** 남은 예산 안에서 내어 줄 수 있는 양(순수 함수) */
export function grantable(used: number, limit: number, want: number): number {
  return Math.max(0, Math.min(want, limit - used));
}

export type Budget = { granted: number; window: Date };

/**
 * 이번 페이지에 쓸 예산을 선점한다. 판정과 가산을 한 트랜잭션에서 해야
 * 동시에 도는 다른 발송이 같은 창의 예산을 함께 통과시키지 않는다.
 */
export async function reserveSendBudget(db: Db, projectId: string, limit: number, want: number, now = new Date()): Promise<Budget> {
  const window = windowStart(now);
  const granted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rate:${projectId}`}))`);
    const cur = (
      await tx
        .select({ count: pushRateCounters.count })
        .from(pushRateCounters)
        .where(and(eq(pushRateCounters.projectId, projectId), eq(pushRateCounters.windowStart, window)))
        .limit(1)
    )[0];
    const grant = grantable(cur?.count ?? 0, limit, want);
    if (grant === 0) return 0;
    await tx
      .insert(pushRateCounters)
      .values({ projectId, windowStart: window, count: grant })
      .onConflictDoUpdate({
        target: [pushRateCounters.projectId, pushRateCounters.windowStart],
        set: { count: sql`${pushRateCounters.count} + ${grant}` },
      });
    return grant;
  });
  return { granted, window };
}

/** 선점했지만 실제로 보내지 않은 몫을 돌려준다 — 안 돌려주면 대상이 적은 발송이 창 전체를 잠근다. */
export async function refundSendBudget(db: Db, projectId: string, window: Date, n: number): Promise<void> {
  if (n <= 0) return;
  await db
    .update(pushRateCounters)
    .set({ count: sql`greatest(0, ${pushRateCounters.count} - ${n})` })
    .where(and(eq(pushRateCounters.projectId, projectId), eq(pushRateCounters.windowStart, window)));
}

export async function purgeRateWindows(db: Db, projectId: string, now = new Date()): Promise<void> {
  await db
    .delete(pushRateCounters)
    .where(
      and(eq(pushRateCounters.projectId, projectId), lt(pushRateCounters.windowStart, new Date(now.getTime() - RATE_RETENTION_MS)))
    );
}
