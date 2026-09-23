import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { audienceFromCounts, notSuppressed, userNotSuppressed } from "./audience-count";

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
