import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { PushLog } from "@/db/schema";
import { cancelDto, cancelPushLog, CANCELABLE_STATUSES, sentSoFar } from "./push-cancel";
import { claimableLog, initialState } from "./push-resume";

const PROJ = "22222222-2222-2222-2222-222222222222";
const LOG = "33333333-3333-3333-3333-333333333333";
const sqlOf = (q: SQL | undefined) => new PgDialect().sqlToQuery(q!);

const logRow = (over: Partial<PushLog> = {}): PushLog =>
  ({
    id: LOG,
    projectId: PROJ,
    status: "processing",
    resumeCursor: null,
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    holdoutCount: 0,
    canceledAt: null,
    canceledBy: null,
    ...over,
  }) as unknown as PushLog;

/** update().set().where().returning() 과 select().from().where().limit() 만 흉내 낸다 */
function makeDb(before: PushLog | undefined) {
  const calls: { set?: Record<string, unknown>; where?: SQL } = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (before ? [before] : []) }) }) }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        calls.set = set;
        return {
          where: (where: SQL) => {
            calls.where = where;
            return {
              returning: async () =>
                before && (CANCELABLE_STATUSES as readonly string[]).includes(before.status)
                  ? [{ ...before, ...set }]
                  : [],
            };
          },
        };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof cancelPushLog>[0], calls };
}

describe("취소 CAS", () => {
  it("취소된 로그는 클레임 조건에 걸리지 않는다 — 어떤 워커도 다시 집지 못한다", () => {
    const where = sqlOf(claimableLog(new Date("2026-01-01T00:00:00Z"), new Date("2025-12-31T23:55:00Z")));
    // 조건은 queued / scheduled / processing 세 상태만 본다. 'canceled' 는 어디에도 없다.
    expect(where.sql).not.toContain("canceled");
    expect(where.params).toContain("queued");
    expect(where.params).toContain("processing");
    expect(where.params).not.toContain("canceled");
  });

  it("진행 중인 발송을 멈추면서 소유권을 뺏고 이미 나간 수를 굳힌다", async () => {
    const state = { ...initialState({ users: 500, devices: 900 }, null), total: 420, success: 400, failure: 20, holdout: 55 };
    const { db, calls } = makeDb(logRow({ resumeCursor: JSON.stringify(state) }));

    const out = await cancelPushLog(db, PROJ, LOG, "ops@example.com");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 이미 나간 수를 감추지 않는다 — "취소됨"만 보이면 아무에게도 안 갔다고 읽는다
    expect(out.sent).toEqual({ total: 420, success: 400, failure: 20, holdout: 55 });
    expect(calls.set).toMatchObject({ status: "canceled", canceledBy: "ops@example.com", totalCount: 420, successCount: 400 });
    // lock_token 을 비워야 진행 중이던 워커가 다음 저장에서 멈춘다. 그대로 두면 끝까지 다 보낸다.
    expect(calls.set?.lockToken).toBeNull();
    expect(out.log.canceledAt).toBeInstanceOf(Date);
  });

  it("진행 상태가 깨졌어도 로그 칼럼의 수는 잃지 않는다", () => {
    expect(sentSoFar(logRow({ resumeCursor: "not json", totalCount: 7, successCount: 6, failureCount: 1, holdoutCount: 2 })))
      .toEqual({ total: 7, success: 6, failure: 1, holdout: 2 });
  });

  it("칼럼과 진행 상태 중 큰 쪽을 쓴다 — 한쪽만 보면 취소 직전 페이지를 잃는다", () => {
    const state = { ...initialState({ users: 1, devices: 1 }, null), total: 300, success: 290, failure: 10 };
    expect(sentSoFar(logRow({ resumeCursor: JSON.stringify(state), totalCount: 500, successCount: 100, holdoutCount: 3 })))
      .toEqual({ total: 500, success: 290, failure: 10, holdout: 3 });
  });

  it("끝난 발송은 409 — 되돌릴 것이 없다", async () => {
    for (const status of ["completed", "logged", "failed", "canceled"]) {
      const { db } = makeDb(logRow({ status }));
      const out = await cancelPushLog(db, PROJ, LOG, "ops@example.com");
      expect(out).toEqual({ ok: false, reason: "already_terminal", status });
    }
  });

  it("다른 프로젝트·없는 id 는 404", async () => {
    const { db } = makeDb(undefined);
    expect(await cancelPushLog(db, PROJ, LOG, "ops@example.com")).toEqual({ ok: false, reason: "not_found" });
  });

  it("응답은 취소 사실과 이미 나간 수를 함께 준다", () => {
    const dto = cancelDto(logRow({ status: "canceled", canceledAt: new Date("2026-09-24T01:02:03Z"), canceledBy: "a@b.c" }), {
      total: 10,
      success: 9,
      failure: 1,
      holdout: 2,
    });
    expect(dto).toEqual({
      id: LOG,
      status: "canceled",
      canceled_at: "2026-09-24T01:02:03.000Z",
      canceled_by: "a@b.c",
      sent: { total: 10, success: 9, failure: 1, holdout: 2 },
    });
  });
});
