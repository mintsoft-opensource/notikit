import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { audienceFromCounts, countAudience, notSuppressed, scopedDevicePage, resolveScope, userNotSuppressed, type Db } from "./audience-count";

const dialect = new PgDialect();

describe("audienceFromCounts", () => {
  it("maps SQL aggregates and puts unknown platforms into other", () => {
    expect(audienceFromCounts({ devices: 5, users: 3, ios: 1, android: 2, web: 1 })).toEqual({
      users: 3,
      devices: 5,
      platforms: { ios: 1, android: 2, web: 1, other: 1 },
    });
  });

  it("treats null/string aggregates from the driver as numbers", () => {
    const row = { devices: "2", users: null, ios: "0", android: "2", web: null } as unknown as Parameters<typeof audienceFromCounts>[0];
    expect(audienceFromCounts(row)).toEqual({ users: 0, devices: 2, platforms: { ios: 0, android: 2, web: 0, other: 0 } });
  });

  it("never returns a negative other bucket", () => {
    expect(audienceFromCounts({ devices: 1, users: 1, ios: 1, android: 1, web: 0 }).platforms.other).toBe(0);
  });
});

describe("behaviour segments keep anonymous devices", () => {
  const PID = "11111111-1111-1111-1111-111111111111";
  const DORMANT = [{ source: "activity", op: "not_within_days", days: 30 }];

  /** 응답을 차례대로 돌려주는 가짜 드라이버 — 첫 질의는 토픽, 다음이 실제 집계/페이지 */
  function fakeDb(responses: unknown[][][]) {
    const queries: string[] = [];
    const db = drizzle(async (q) => {
      queries.push(q);
      return { rows: responses[queries.length - 1] ?? [] };
    }) as unknown as Db;
    return { db, queries };
  }

  const target = { projectId: PID, type: "topic" as const, target: "dormant", targets: null };

  it("counts the send audience with a left join, not an inner join", async () => {
    const { db, queries } = fakeDb([[["t1", DORMANT]], [[9, 4, 1, 2, 6]]]);
    const a = await countAudience(db, target);
    expect(a.devices).toBe(9);
    // 발송 추정과 실제 발송이 같은 함수를 타므로, 여기서 익명 기기가 빠지면 둘 다 빠진다
    expect(queries[1]).toContain('left join "push_users"');
    expect(queries[1]).not.toContain("inner join");
  });

  it("pages the send audience with the same join and the behaviour subquery", async () => {
    const { db, queries } = fakeDb([[["t1", DORMANT]], []]);
    const scope = await resolveScope(db, target);
    expect(scope?.kind).toBe("rules");
    await scopedDevicePage(db, scope!, "00000000-0000-0000-0000-000000000000", 10);
    expect(queries[1]).toContain('left join "push_users"');
    expect(queries[1]).toContain('b.device_id = "devices"."id"');
  });
});

describe("suppression filters", () => {
  const PID = "11111111-1111-1111-1111-111111111111";

  it("excludes follow-up users suppressed by external_id within the project", () => {
    const q = dialect.sqlToQuery(userNotSuppressed(PID));
    expect(q.sql).toContain("not exists");
    expect(q.sql).toContain('s.external_id = "push_users"."external_id"');
    expect(q.params).toEqual([PID]);
  });

  it("excludes devices suppressed by token or by their user's external_id", () => {
    const q = dialect.sqlToQuery(notSuppressed(PID));
    expect(q.sql).toContain('s.token = "devices"."token"');
    expect(q.sql).toContain('su.id = "devices"."user_id"');
    expect(q.params).toEqual([PID, PID]);
  });
});
