import { describe, it, expect } from "vitest";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { attrConds, countTopicAudience, ruleCond, rulesSchema, type TopicRule } from "./topic-membership";

const dialect = new PgDialect();
const PROJECT = "11111111-1111-1111-1111-111111111111";
const render = (r: TopicRule) => dialect.sqlToQuery(ruleCond(r, PROJECT));

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
    const conds = attrConds(
      [
        { attribute: "a", value: "1" },
        { attribute: "b", op: "lt", value: "2" },
      ],
      PROJECT
    );
    expect(conds).toHaveLength(2);
    expect(dialect.sqlToQuery(and(...conds)!).sql).toContain(" and ");
  });
});

describe("behaviour rules → SQL", () => {
  it("looks for the device first so devices without a user still match", () => {
    const q = render({ source: "click", op: "within_days", days: 7 });
    expect(q.sql).toContain("exists (select 1 from \"push_clicks\" b");
    // 기기 id 로 먼저 찾는다 — 사람이 없는 기기가 여기서 빠지면 세그먼트가 반토막 난다
    expect(q.sql).toContain('b.device_id = "devices"."id"');
    expect(q.sql).toContain('"devices"."user_id" is not null and b.user_id = "devices"."user_id"');
    expect(q.sql).toContain("b.clicked_at >= now() - make_interval");
    expect(q.params).toEqual([PROJECT, 7]);
  });

  it("negates with NOT EXISTS so people who never did it also match", () => {
    const q = render({ source: "activity", op: "not_within_days", days: 30 });
    expect(q.sql).toContain("not exists (select 1 from \"device_activity\" b");
    // 접속 롤업은 (기기, UTC 날짜)라 기기 단위로만 본다
    expect(q.sql).toContain('b.device_id = "devices"."id"');
    expect(q.sql).not.toContain("b.user_id");
    expect(q.sql).toContain("b.day >= ((now() at time zone 'utc')::date - $2::int)");
  });

  it("counts instead of existence for count_gte, with the window optional", () => {
    const windowed = render({ source: "click", op: "count_gte", count: 3, days: 14 });
    expect(windowed.sql).toContain('(select count(*) from "push_clicks" b');
    expect(windowed.sql).toContain(">= $3::int");
    expect(windowed.params).toEqual([PROJECT, 14, 3]);

    const lifetime = render({ source: "click", op: "count_gte", count: 2 });
    expect(lifetime.sql).not.toContain("make_interval");
    expect(lifetime.params).toEqual([PROJECT, 2]);
  });

  it("filters conversions by name as a bound parameter", () => {
    const q = render({ source: "conversion", op: "within_days", days: 30, name: "'; drop table x; --" });
    expect(q.sql).toContain('from "push_conversions" b');
    expect(q.sql).toContain("b.name = $2");
    expect(q.sql).not.toContain("drop table");
    expect(q.params).toEqual([PROJECT, "'; drop table x; --", 30]);
  });

  it("matches sends on the user only — anonymous devices have no send rows", () => {
    const q = render({ source: "send", op: "not_within_days", days: 1 });
    expect(q.sql).toContain('from "push_user_sends" b');
    expect(q.sql).not.toContain("b.device_id");
    expect(q.sql).toContain('"devices"."user_id" is not null');
  });

  it("matches nobody when a stored behaviour rule is missing its window or count", () => {
    // 기간 없는 not_within_days 를 통과시키면 "한 번도 안 한 사람 전부"가 되어 대상이 부푼다
    expect(render({ source: "activity", op: "not_within_days" }).sql).toBe("false");
    expect(render({ source: "click", op: "within_days" }).sql).toBe("false");
    expect(render({ source: "click", op: "count_gte" }).sql).toBe("false");
    expect(render({ source: "click", op: "within_days", days: 0 }).sql).toBe("false");
    expect(render({ source: "click", op: "within_days", days: 366 }).sql).toBe("false");
    expect(render({ source: "click", op: "within_days", days: 1.5 }).sql).toBe("false");
  });

  it("mixes attribute and behaviour rules in one AND list", () => {
    const conds = attrConds(
      [{ attribute: "plan", value: "pro" }, { source: "click", op: "within_days", days: 7 }],
      PROJECT
    );
    const q = dialect.sqlToQuery(and(...conds)!);
    expect(q.sql).toContain("->>");
    expect(q.sql).toContain("exists");
  });
});

describe("rulesSchema", () => {
  it("accepts rules without op", () => {
    expect(rulesSchema.safeParse([{ attribute: "plan", value: "pro" }]).success).toBe(true);
  });

  it("accepts behaviour rules and drops fields the operator does not use", () => {
    const parsed = rulesSchema.safeParse([
      { source: "click", op: "within_days", days: 7, count: 9 },
      { source: "conversion", op: "count_gte", count: 2, name: "purchase" },
    ]);
    expect(parsed.success).toBe(true);
    // count 는 count_gte 에서만 조건이 된다 — 남겨 두면 없는 조건을 있다고 읽게 된다
    expect(parsed.data?.[0]).toEqual({ source: "click", op: "within_days", days: 7 });
    expect(parsed.data?.[1]).toEqual({ source: "conversion", op: "count_gte", count: 2, name: "purchase" });
  });

  it("names the broken field instead of collapsing to a union error", () => {
    const noDays = rulesSchema.safeParse([{ source: "activity", op: "not_within_days" }]);
    expect(noDays.success).toBe(false);
    expect(noDays.error?.issues[0]?.message).toContain("days");

    const noCount = rulesSchema.safeParse([{ source: "click", op: "count_gte" }]);
    expect(noCount.error?.issues[0]?.message).toContain("count");

    // 속성 규칙의 기존 메시지도 그대로 나온다
    const badNumber = rulesSchema.safeParse([{ attribute: "a", op: "gt", value: "ten" }]);
    expect(badNumber.error?.issues[0]?.message).toContain("must be a number");
  });

  it("rejects unknown sources, out-of-range windows and names on nameless sources", () => {
    expect(rulesSchema.safeParse([{ source: "login", op: "within_days", days: 7 }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ source: "click", op: "within_days", days: 0 }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ source: "click", op: "within_days", days: 400 }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ source: "click", op: "within_days", days: 7, name: "x" }]).success).toBe(false);
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

  it("keeps devices without a user in behaviour segments", async () => {
    const { db, queries } = fakeDb([9, 4]);
    await countTopicAudience(db, PID, {
      id: "t3",
      rules: [{ source: "activity", op: "not_within_days", days: 30 }],
    });

    // 이 한 줄이 전부다: inner join 이면 익명 기기가 통째로 빠져 "30일 휴면" 세그먼트가
    // 조용히 반토막 나고, 줄어든 쪽은 아무 오류도 내지 않는다.
    expect(queries[0]).toContain('left join "push_users"');
    expect(queries[0]).not.toContain("inner join");
    expect(queries[0]).toContain('b.device_id = "devices"."id"');
  });

  it("still excludes devices without a user from attribute segments", async () => {
    const { db, queries } = fakeDb([2, 2]);
    await countTopicAudience(db, PID, { id: "t4", rules: [{ attribute: "plan", value: "pro" }] });
    // left join 으로 바꿔도 뜻은 그대로다 — user 가 없으면 attributes ->> k 가 NULL 이라 안 맞는다
    expect(queries[0]).toContain('left join "push_users"');
    expect(queries[0]).toContain('"push_users"."attributes" ->>');
  });

  it("returns zeros when the aggregate row is empty", async () => {
    const { db } = fakeDb([null, null]);
    expect(await countTopicAudience(db, PID, { id: "t1", rules: null })).toEqual({ devices: 0, users: 0 });
  });
});
