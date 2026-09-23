import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushLogs, webhookDeliveries } from "@/db/schema";

const { state } = vi.hoisted(() => ({
  state: {
    logIds: [] as string[][],
    deliveryIds: [] as string[][],
    deleted: [] as string[],
  },
}));

vi.mock("@/lib/authz", () => ({
  checkOrigin: () => true,
  requireProject: async () => ({ ok: true }),
}));

vi.mock("@/db/client", () => {
  type Table = typeof pushLogs | typeof webhookDeliveries;
  const nameOf = (t: Table) => (t === pushLogs ? "push_logs" : "webhook_deliveries");
  const nextIds = (t: Table) => (t === pushLogs ? state.logIds.shift() : state.deliveryIds.shift()) ?? [];

  const chain = (rows: Array<{ id: string }>) => {
    const self = {
      innerJoin: () => self,
      where: () => self,
      limit: () => Promise.resolve(rows),
    };
    return self;
  };

  return {
    getDb: () => ({
      select: () => ({ from: (t: Table) => chain(nextIds(t).map((id) => ({ id }))) }),
      delete: (t: Table) => ({
        where: () => {
          state.deleted.push(nameOf(t));
          return Promise.resolve();
        },
      }),
      execute: () => Promise.resolve([{ n: 0 }]),
    }),
  };
});

describe("로그 리텐션 purge", () => {
  beforeEach(() => {
    state.logIds = [];
    state.deliveryIds = [];
    state.deleted = [];
  });

  const call = async (retention: string | undefined) => {
    if (retention === undefined) delete process.env.LOG_RETENTION_DAYS;
    else process.env.LOG_RETENTION_DAYS = retention;
    const { POST } = await import("./route");
    const req = new Request("http://localhost/api/admin/projects/p1/logs/purge", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: "p1" }) });
    return (await res.json()) as { data: Record<string, unknown> };
  };

  it("리텐션 미설정이면 아무것도 지우지 않는다", async () => {
    const body = await call(undefined);
    expect(body.data.purged).toBe(0);
    expect(body.data.purgedWebhookDeliveries).toBe(0);
    expect(body.data.retentionDays).toBeNull();
    expect(state.deleted).toHaveLength(0);
  });

  it("0 이하 설정은 '끄기'가 아니라 실수로 보고 전체 삭제를 막는다", async () => {
    expect((await call("0")).data.purged).toBe(0);
    expect((await call("-5")).data.purged).toBe(0);
    expect((await call("nope")).data.purged).toBe(0);
    expect(state.deleted).toHaveLength(0);
  });

  it("만료된 종료 로그와 정착된 웹훅 배달을 같은 창으로 지운다", async () => {
    state.logIds = [["l1", "l2"]];
    state.deliveryIds = [["d1", "d2", "d3"]];

    const body = await call("30");
    expect(body.data.purged).toBe(2);
    // 배달 이력은 push_logs 와 FK 로 묶여 있지 않아 따로 지워 주지 않으면 무한히 자란다
    expect(body.data.purgedWebhookDeliveries).toBe(3);
    expect(body.data.done).toBe(true);
    expect(state.deleted).toEqual(["push_logs", "webhook_deliveries"]);
    expect(body.data.cutoff).toEqual(expect.any(String));
  });

  it("지울 배달만 있고 로그는 없어도 배달을 지운다", async () => {
    state.deliveryIds = [["d1"]];
    const body = await call("7");
    expect(body.data.purged).toBe(0);
    expect(body.data.purgedWebhookDeliveries).toBe(1);
    expect(state.deleted).toEqual(["webhook_deliveries"]);
  });

  it("배치가 가득 차면 다음 배치를 이어서 돈다", async () => {
    const full = Array.from({ length: 5_000 }, (_, i) => `l${i}`);
    state.logIds = [full, ["tail"]];
    const body = await call("30");
    expect(body.data.purged).toBe(5_001);
    expect(body.data.done).toBe(true);
  });

  it("한 호출에서 다 비우지 못하면 done=false 로 알린다", async () => {
    const full = Array.from({ length: 5_000 }, (_, i) => `l${i}`);
    state.logIds = Array.from({ length: 20 }, () => full);
    const body = await call("30");
    expect(body.data.purged).toBe(100_000);
    expect(body.data.done).toBe(false);
  });
});
