import { describe, it, expect } from "vitest";
import {
  applyFrequencyCap,
  buildItems,
  deliveredRows,
  releasableUsers,
  chunk,
  initialState,
  mapLimit,
  multicastGroups,
  parseResumeState,
  tallyResults,
  variantIndex,
  type ResumeState,
} from "./push-processor";

const DEV = "11111111-1111-1111-1111-111111111111";

describe("resume state", () => {
  it("round-trips through JSON so a reclaimed run continues from the cursor with totals", () => {
    const s: ResumeState = { ...initialState({ users: 3, devices: 4 }, 2), cursor: DEV, total: 10, success: 7, failure: 3 };
    expect(parseResumeState(JSON.stringify(s))).toEqual(s);
  });

  it("starts at the zero cursor with per-variant slots", () => {
    const s = initialState({ users: 1, devices: 2 }, 2);
    expect(s.cursor).toBe("00000000-0000-0000-0000-000000000000");
    expect(s.variantStats).toEqual({ "0": { sent: 0, success: 0 }, "1": { sent: 0, success: 0 } });
    expect(initialState({ users: 0, devices: 0 }, null).variantStats).toBeNull();
  });

  it("rejects missing, malformed or tampered state instead of skipping recipients", () => {
    expect(parseResumeState(null)).toBeNull();
    expect(parseResumeState("not json")).toBeNull();
    const good = initialState({ users: 1, devices: 1 }, null);
    expect(parseResumeState(JSON.stringify({ ...good, cursor: "x' or 1=1" }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, total: -1 }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, audience: null }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, variantStats: { "0": { sent: "a" } } }))).toBeNull();
  });
});

describe("applyFrequencyCap", () => {
  const rows = [
    { userId: "u1", token: "a" },
    { userId: "u1", token: "b" },
    { userId: "u2", token: "c" },
    { userId: null, token: "d" },
  ];

  it("drops every device of users at or over the cap, keeps anonymous devices", () => {
    const r = applyFrequencyCap(rows, new Map([["u1", 2], ["u2", 1]]), 2);
    expect(r.allowed.map((x) => x.token)).toEqual(["c", "d"]);
    expect(r.capped).toBe(2);
  });

  it("is a no-op without a cap", () => {
    expect(applyFrequencyCap(rows, new Map([["u1", 99]]), null)).toEqual({ allowed: rows, capped: 0 });
  });

  it("cap 0 blocks all identified users", () => {
    expect(applyFrequencyCap(rows, new Map(), 0).allowed.map((x) => x.token)).toEqual(["d"]);
  });
});

describe("buildItems / multicastGroups", () => {
  const rows = [
    { token: "t1", platform: "ios" },
    { token: "t2", platform: "web" },
    { token: "t3", platform: "android" },
  ];

  it("marks web as data-only and keeps content without a renderer", () => {
    const items = buildItems(rows, { title: "T", body: "B" }, null, null);
    expect(items.map((i) => [i.token, i.dataOnly, i.vi, i.title])).toEqual([
      ["t1", false, null, "T"],
      ["t2", true, null, "T"],
      ["t3", false, null, "T"],
    ]);
  });

  it("assigns variants deterministically and renders per token", () => {
    const variants = [{ title: "A", body: "a" }, { title: "B", body: "b" }];
    const items = buildItems(rows, { title: "T", body: "B" }, variants, (text, token) => `${text}:${token}`);
    for (const it of items) {
      expect(it.vi).toBe(variantIndex(it.token, 2));
      expect(it.title).toBe(`${variants[it.vi!].title}:${it.token}`);
    }
  });

  it("groups identical content per payload shape and splits at 500", () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ token: `n${i}`, platform: "android" }));
    const items = buildItems([...many, { token: "w", platform: "web" }], { title: "T", body: "B" }, null, null);
    const groups = multicastGroups(items);
    expect(groups.map((g) => [g.dataOnly, g.tokens.length])).toEqual([
      [false, 500],
      [false, 500],
      [false, 1],
      [true, 1],
    ]);
  });
});

describe("tallyResults", () => {
  it("adds counts and attributes successes to the variant of each accepted token", () => {
    const state = initialState({ users: 2, devices: 2 }, 2);
    const items = [
      { token: "a", vi: 0, title: "", body: "", dataOnly: false },
      { token: "b", vi: 1, title: "", body: "", dataOnly: false },
    ];
    const next = tallyResults(state, items, [{ success: 1, failure: 1, invalidTokens: ["b"], validTokens: ["a"] }]);
    expect(next.success).toBe(1);
    expect(next.failure).toBe(1);
    expect(next.variantStats).toEqual({ "0": { sent: 0, success: 1 }, "1": { sent: 0, success: 0 } });
    expect(state.variantStats!["0"].success).toBe(0); // 원본 불변
  });
});

describe("helpers", () => {
  it("chunk splits evenly", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("mapLimit preserves order under concurrency", async () => {
    const out = await mapLimit([30, 10, 20], 2, (ms) => new Promise<number>((r) => setTimeout(() => r(ms), ms)));
    expect(out).toEqual([30, 10, 20]);
  });
});

describe("deliveredRows", () => {
  const rows = [
    { token: "a", userId: "u1" },
    { token: "b", userId: "u1" },
    { token: "c", userId: "u2" },
    { token: "d", userId: null },
  ];

  it("keeps only rows whose token was delivered", () => {
    expect(deliveredRows(rows, ["b", "d"])).toEqual([rows[1], rows[3]]);
  });

  it("returns nothing when every send failed", () => {
    expect(deliveredRows(rows, [])).toEqual([]);
  });

  it("ignores delivered tokens that are not in the page", () => {
    expect(deliveredRows(rows, ["z", "c"])).toEqual([rows[2]]);
  });
});

describe("releasableUsers", () => {
  const allowed = [
    { token: "a", userId: "u1" },
    { token: "b", userId: "u1" },
    { token: "c", userId: "u2" },
    { token: "d", userId: null },
  ];

  it("releases reserved users none of whose devices were delivered", () => {
    expect(releasableUsers(["u1", "u2"], allowed, ["b"])).toEqual(["u2"]);
  });

  it("releases every reservation when nothing was delivered", () => {
    expect(releasableUsers(["u1", "u2"], allowed, [])).toEqual(["u1", "u2"]);
  });

  it("never releases users this page did not newly reserve", () => {
    expect(releasableUsers(["u2"], allowed, [])).toEqual(["u2"]);
    expect(releasableUsers([], allowed, [])).toEqual([]);
  });
});

describe("parseResumeState follow-ups", () => {
  const base = initialState({ users: 1, devices: 1 }, null);

  it("keeps the finalizing phase and completed steps across a reclaim", () => {
    const s: ResumeState = { ...base, followUps: { inbox: true } };
    expect(parseResumeState(JSON.stringify(s))?.followUps).toEqual({ inbox: true });
  });

  it("treats a malformed follow-up record as finalizing with nothing done", () => {
    const raw = JSON.stringify({ ...base, followUps: { inbox: "yes", kakao: true, bogus: true } });
    expect(parseResumeState(raw)?.followUps).toEqual({ kakao: true });
    expect(parseResumeState(JSON.stringify({ ...base, followUps: 3 }))?.followUps).toEqual({});
  });

  it("leaves sending-phase state without follow-ups", () => {
    expect(parseResumeState(JSON.stringify(base))).not.toHaveProperty("followUps");
  });
});
