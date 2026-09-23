import { describe, it, expect } from "vitest";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { attrConds, countTopicAudience, ruleCond, rulesSchema, type TopicRule } from "./topic-membership";

const dialect = new PgDialect();
const render = (r: TopicRule) => dialect.sqlToQuery(ruleCond(r));

describe("ruleCond", () => {
  it("treats a rule without op as equality (legacy rows)", () => {
    const q = render({ attribute: "plan", value: "pro" });
    expect(q.sql).toContain("->> $1) = $2");
    expect(q.params).toEqual(["plan", "pro"]);
  });

  it("builds neq and contains with bound params only", () => {
    expect(render({ attribute: "plan", op: "neq", value: "free" }).sql).toContain("<> $2");
    const c = render({ attribute: "name", op: "contains", value: "'; drop table x; --" });
    expect(c.sql).toContain("strpos(lower(");
    expect(c.sql).not.toContain("drop table");
    expect(c.params).toEqual(["name", "'; drop table x; --"]);
  });

  it("guards numeric comparisons so non-numeric attributes never cast", () => {
    const q = render({ attribute: "age", op: "gte", value: " 18 " });
    expect(q.sql).toContain("CASE WHEN");
    expect(q.sql).toContain("::numeric END) >= $");
    expect(q.params).toContain("18");
  });

  it.each(["gt", "gte", "lt", "lte"] as const)("maps %s to its operator", (op) => {
    const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
    expect(render({ attribute: "n", op, value: "1" }).sql).toContain(`END) ${sym} $`);
  });

  it("matches nobody when a numeric op gets a non-numeric value", () => {
    const q = render({ attribute: "age", op: "gt", value: "abc" });
    expect(q.sql).toBe("false");
    expect(q.params).toEqual([]);
  });

  it("ANDs multiple rules", () => {
    const conds = attrConds([
      { attribute: "a", value: "1" },
      { attribute: "b", op: "lt", value: "2" },
    ]);
    expect(conds).toHaveLength(2);
    expect(dialect.sqlToQuery(and(...conds)!).sql).toContain(" and ");
  });
});

describe("rulesSchema", () => {
  it("accepts rules without op", () => {
    expect(rulesSchema.safeParse([{ attribute: "plan", value: "pro" }]).success).toBe(true);
  });

  it("rejects unknown ops and non-numeric values for numeric ops", () => {
    expect(rulesSchema.safeParse([{ attribute: "a", op: "like", value: "x" }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ attribute: "a", op: "gt", value: "ten" }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ attribute: "a", op: "gt", value: "-1.5" }]).success).toBe(true);
  });

  it("rejects an empty rule list", () => {
    expect(rulesSchema.safeParse([]).success).toBe(false);
  });
});

describe("countTopicAudience", () => {
  const PID = "11111111-1111-1111-1111-111111111111";
  type CountDb = Parameters<typeof countTopicAudience>[0];

  function fakeDb(row: unknown[]) {
    const queries: string[] = [];
    const db = drizzle(async (q) => {
      queries.push(q);
      return { rows: [row] };
    }) as unknown as CountDb;
    return { db, queries };
  }

  it("counts subscribed topics in SQL with the same suppression exclusion as sending", async () => {
    const { db, queries } = fakeDb([7, 4]);
    const c = await countTopicAudience(db, PID, { id: "t1", rules: null });
    expect(c).toEqual({ devices: 7, users: 4 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("count(*)::int");
    expect(queries[0]).toContain("count(distinct");
    expect(queries[0]).toContain('s.token = "devices"."token"');
    expect(queries[0]).toContain('from "subscriptions"');
  });

  it("counts rule-filled topics with attribute conditions and suppression exclusion", async () => {
    const { db, queries } = fakeDb([2, 2]);
    const c = await countTopicAudience(db, PID, { id: "t2", rules: [{ attribute: "plan", value: "pro" }] });
    expect(c).toEqual({ devices: 2, users: 2 });
    expect(queries[0]).toContain("->>");
    expect(queries[0]).toContain("not exists");
  });

  it("returns zeros when the aggregate row is empty", async () => {
    const { db } = fakeDb([null, null]);
    expect(await countTopicAudience(db, PID, { id: "t1", rules: null })).toEqual({ devices: 0, users: 0 });
  });
});
