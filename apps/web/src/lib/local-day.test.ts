import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { localDayBoundaryIso } from "./local-day";

describe("localDayBoundaryIso", () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/New_York";
  });
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("uses each day's own offset across the spring-forward DST change", () => {
    // 2026-03-08 02:00 EST → EDT. 전날은 UTC-5, 다음날은 UTC-4.
    expect(localDayBoundaryIso("2026-03-07")).toBe("2026-03-07T05:00:00.000Z");
    expect(localDayBoundaryIso("2026-03-09")).toBe("2026-03-09T04:00:00.000Z");
    // 3/8 하루(미포함 끝)는 23시간
    expect(localDayBoundaryIso("2026-03-08", true)).toBe("2026-03-09T04:00:00.000Z");
  });

  it("returns the next local midnight as the exclusive end across fall-back", () => {
    // 2026-11-01 02:00 EDT → EST. 그날 자정은 UTC-4, 다음날 자정은 UTC-5.
    expect(localDayBoundaryIso("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
    expect(localDayBoundaryIso("2026-11-01", true)).toBe("2026-11-02T05:00:00.000Z");
  });

  it("rejects malformed input", () => {
    expect(localDayBoundaryIso("2026-0")).toBeNull();
    expect(localDayBoundaryIso("")).toBeNull();
  });
});
