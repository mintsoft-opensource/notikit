import { describe, it, expect } from "vitest";
import { pctChange, ptChange, ratio } from "./stat-delta";

describe("pctChange", () => {
  it("returns signed percent change rounded to one decimal", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(2, 3)).toBe(-33.3);
    expect(pctChange(5, 5)).toBe(0);
  });

  it("returns null when there is nothing to compare against", () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(Number.NaN, 1)).toBeNull();
  });
});

describe("ptChange", () => {
  it("returns percentage-point difference", () => {
    expect(ptChange(0.25, 0.2)).toBe(5);
    expect(ptChange(0.1, 0.125)).toBe(-2.5);
  });

  it("returns null when either rate is undefined", () => {
    expect(ptChange(null, 0.2)).toBeNull();
    expect(ptChange(0.2, null)).toBeNull();
  });
});

describe("ratio", () => {
  it("is null for a zero denominator", () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});
