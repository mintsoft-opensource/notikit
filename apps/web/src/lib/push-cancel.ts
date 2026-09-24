/**
 * 발송 취소 — 대기·예약·진행 중인 발송을 멈춘다.
 *
 * 두 가지를 동시에 지켜야 한다.
 *
 * 1. **더 못 집게 한다.** `status='canceled'` 는 클레임 조건(`claimableLog`: queued/scheduled/processing)
 *    어디에도 없으므로 새 워커는 이 로그를 집지 못한다. 진행 중이던 워커는 `lock_token` 을 함께
 *    비워 소유권을 뺏는다 — 다음 페이지를 저장(`saveProgress`)하려는 순간 false 를 받고 멈춘다.
 *    토큰을 그대로 두면 워커는 취소를 모른 채 끝까지 다 보내고, 화면만 "취소됨"이 된다.
 *
 * 2. **이미 나간 수를 굳힌다.** 진행 중 집계는 `resume_cursor`(JSON) 안에만 있다. 취소가 그 값을
 *    로그 칼럼으로 옮기지 않으면 `total/success` 가 0 으로 남아 "아무에게도 안 갔다"로 보인다 —
 *    실제로는 수만 건이 나간 뒤일 수 있다.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { pushLogs, type PushLog } from "@/db/schema";
import { parseResumeState, type ResumeState } from "@/lib/push-resume";
import type { Db } from "@/lib/audience-count";

/** 취소할 수 있는 상태. 끝난 발송(completed/logged/failed)과 이미 취소된 것은 되돌릴 게 없다. */
export const CANCELABLE_STATUSES = ["queued", "scheduled", "processing"] as const;

export type CancelOutcome =
  | { ok: true; log: PushLog; sent: SentSoFar }
  | { ok: false; reason: "not_found" | "already_terminal"; status?: string };

/** 취소 시점까지 실제로 나간 수 */
export type SentSoFar = { total: number; success: number; failure: number; holdout: number };

/** 진행 상태(JSON)와 로그 칼럼 중 **큰 쪽** — 둘 중 하나만 보면 취소 직전 페이지를 잃는다(순수 함수). */
export function sentSoFar(log: Pick<PushLog, "resumeCursor" | "totalCount" | "successCount" | "failureCount" | "holdoutCount">): SentSoFar {
  const s = parseResumeState(log.resumeCursor);
  return {
    total: Math.max(log.totalCount, s?.total ?? 0),
    success: Math.max(log.successCount, s?.success ?? 0),
    failure: Math.max(log.failureCount, s?.failure ?? 0),
    holdout: Math.max(log.holdoutCount, s?.holdout ?? 0),
  };
}

/**
 * 취소 CAS. 취소 가능한 상태일 때만 한 번에 상태·집계·소유권 해제를 적는다.
 * 경합(워커가 방금 완료로 닫음)에서 진 경우는 업데이트 0행 → `already_terminal`.
 */
export async function cancelPushLog(db: Db, projectId: string, logId: string, by: string): Promise<CancelOutcome> {
  const before = (
    await db.select().from(pushLogs).where(and(eq(pushLogs.id, logId), eq(pushLogs.projectId, projectId))).limit(1)
  )[0];
  if (!before) return { ok: false, reason: "not_found" };

  const sent = sentSoFar(before);
  const rows = await db
    .update(pushLogs)
    .set({
      status: "canceled",
      canceledAt: new Date(),
      canceledBy: by,
      // 소유권 박탈 — 진행 중이던 워커는 다음 저장에서 false 를 받고 페이지를 더 넘기지 않는다
      lockToken: null,
      totalCount: sent.total,
      successCount: sent.success,
      failureCount: sent.failure,
      holdoutCount: sent.holdout,
    })
    .where(
      and(eq(pushLogs.id, logId), eq(pushLogs.projectId, projectId), inArray(pushLogs.status, [...CANCELABLE_STATUSES]))
    )
    .returning();
  if (!rows[0]) return { ok: false, reason: "already_terminal", status: before.status };
  return { ok: true, log: rows[0], sent };
}

/**
 * 취소로 소유권을 잃은 워커가 **마지막 한 페이지분**을 마저 적는다.
 *
 * 취소는 그 순간의 `resume_cursor` 를 굳히지만, 워커가 그 뒤 페이지 하나를 이미 FCM 에 넘겼을 수
 * 있다(커서 저장 전에 취소가 들어온 경우). 그 수를 버리면 "보냈는데 안 보낸 것으로 남는" 건이 생긴다.
 * 줄어드는 방향으로는 절대 쓰지 않는다 — 다른 경합이 더 큰 값을 적었을 수 있다.
 */
export async function recordCanceledProgress(db: Db, logId: string, state: ResumeState): Promise<void> {
  await db
    .update(pushLogs)
    .set({
      totalCount: sql`greatest(${pushLogs.totalCount}, ${state.total})`,
      successCount: sql`greatest(${pushLogs.successCount}, ${state.success})`,
      failureCount: sql`greatest(${pushLogs.failureCount}, ${state.failure})`,
      holdoutCount: sql`greatest(${pushLogs.holdoutCount}, ${state.holdout ?? 0})`,
    })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.status, "canceled")));
}

/** 취소된 발송을 화면·API 에 돌려줄 모양 */
export function cancelDto(log: PushLog, sent: SentSoFar) {
  return {
    id: log.id,
    status: log.status,
    canceled_at: log.canceledAt ? log.canceledAt.toISOString() : null,
    canceled_by: log.canceledBy,
    // "취소했는데 몇 명은 이미 받았다"를 숨기지 않는다
    sent: { total: sent.total, success: sent.success, failure: sent.failure, holdout: sent.holdout },
  };
}
