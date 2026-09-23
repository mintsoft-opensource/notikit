import { describe, it, expect } from "vitest";
import { dedupeRows, parseSuppressionCsv, parseSuppressionJson, splitCsvLine, MAX_IMPORT_ROWS } from "./suppression-import";

describe("splitCsvLine", () => {
  it("handles quoted commas and escaped quotes", () => {
    expect(splitCsvLine('a,"b, c","d ""e"""')).toEqual(["a", "b, c", 'd "e"']);
  });
});

describe("parseSuppressionCsv", () => {
  it("reads user_id rows with optional reason and counts invalid rows", () => {
    const r = parseSuppressionCsv("﻿user_id,reason\r\nu1,opt_out\nu2\n,manual\nu3,nope\n");
    expect(r).toEqual({
      rows: [
        { externalId: "u1", token: null, reason: "opt_out" },
        { externalId: "u2", token: null, reason: "manual" },
      ],
      invalid: 2,
    });
  });

  it("reads token-only files", () => {
    const r = parseSuppressionCsv("token\nabc");
    expect(r).toEqual({ rows: [{ externalId: null, token: "abc", reason: "manual" }], invalid: 0 });
  });

  it("rejects missing headers, empty files and too many rows", () => {
    expect(parseSuppressionCsv("name\nx")).toHaveProperty("error");
    expect(parseSuppressionCsv("  \n")).toHaveProperty("error");
    const big = ["user_id", ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `u${i}`)].join("\n");
    expect(parseSuppressionCsv(big)).toHaveProperty("error");
  });
});

describe("parseSuppressionJson", () => {
  it("accepts user_id, external_id and token keys", () => {
    const r = parseSuppressionJson([{ user_id: "a" }, { external_id: "b", reason: "bounced" }, { token: "t" }, { foo: 1 }]);
    expect(r).toEqual({
      rows: [
        { externalId: "a", token: null, reason: "manual" },
        { externalId: "b", token: null, reason: "bounced" },
        { externalId: null, token: "t", reason: "manual" },
      ],
      invalid: 1,
    });
  });

  it("rejects non-arrays", () => {
    expect(parseSuppressionJson({})).toHaveProperty("error");
  });
});

describe("dedupeRows", () => {
  it("keeps the first of each target", () => {
    const { unique, duplicates } = dedupeRows([
      { externalId: "a", token: null, reason: "manual" },
      { externalId: "a", token: null, reason: "opt_out" },
      { externalId: null, token: "a", reason: "manual" },
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(1);
  });
});
