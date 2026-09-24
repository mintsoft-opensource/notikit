import { describe, it, expect } from "vitest";
import { grantable, nextWindow, reserveSendBudget, windowStart } from "./send-throttle";

const PROJ = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = new Date("2026-09-24T03:00:30.500Z");

/** 트랜잭션 안에서 카운터 한 행만 보는 최소 db */
function fakeDb(store: { count: number | null }) {
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (store.count === null ? [] : [{ count: store.count }]) }) }),
    }),
    insert: () => ({
      values: (v: { count: number }) => ({
        onConflictDoUpdate: async () => {
          store.count = (store.count ?? 0) + v.count;
        },
      }),
    }),
  };
  return { transaction: (cb: (t: unknown) => Promise<number>) => cb(tx) } as unknown as Parameters<typeof reserveSendBudget>[0];
}

describe("창 계산", () => {
  it("초·밀리초를 버린 1분 창과 그 다음 창", () => {
    expect(windowStart(NOW).toISOString()).toBe("2026-09-24T03:00:00.000Z");
    expect(nextWindow(NOW).toISOString()).toBe("2026-09-24T03:01:00.000Z");
  });
});

describe("grantable", () => {
  it("남은 몫까지만 내어 준다", () => {
    expect(grantable(0, 100, 2000)).toBe(100);
    expect(grantable(60, 100, 2000)).toBe(40);
    expect(grantable(100, 100, 2000)).toBe(0);
    expect(grantable(120, 100, 2000)).toBe(0); // 상한을 낮춘 직후
    expect(grantable(0, 5000, 2000)).toBe(2000); // 페이지보다 크면 페이지가 한도
  });
});

describe("reserveSendBudget", () => {
  it("창의 남은 예산만큼만 선점하고, 소진하면 0 을 준다(호출부는 기다리지 않고 반납한다)", async () => {
    const store = { count: null as number | null };
    const db = fakeDb(store);
    expect((await reserveSendBudget(db, PROJ, 100, 2000, NOW)).granted).toBe(100);
    expect(store.count).toBe(100);
    const second = await reserveSendBudget(db, PROJ, 100, 2000, NOW);
    expect(second.granted).toBe(0);
    expect(second.window.toISOString()).toBe("2026-09-24T03:00:00.000Z");
    expect(store.count).toBe(100); // 소진했으면 더 올리지 않는다
  });
});
