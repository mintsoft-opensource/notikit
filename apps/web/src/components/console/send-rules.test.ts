import { describe, expect, test } from "vitest";
import { charLength, collectWarnings, estimateRequest, imageUrlState, platformEntries } from "./send-rules";

describe("imageUrlState", () => {
  test("accepts https and rejects http", () => {
    expect(imageUrlState("https://cdn.example.com/a.png")).toBe("valid");
    expect(imageUrlState("http://cdn.example.com/a.png")).toBe("notHttps");
  });

  test("treats blank as empty and garbage as invalid", () => {
    expect(imageUrlState("  ")).toBe("empty");
    expect(imageUrlState("not a url")).toBe("invalid");
    expect(imageUrlState("ftp://x/y.png")).toBe("invalid");
    expect(imageUrlState(`https://x.dev/${"a".repeat(2100)}`)).toBe("invalid");
  });
});

describe("estimateRequest", () => {
  test("returns null until the target is chosen", () => {
    expect(estimateRequest("single", "", [])).toBeNull();
    expect(estimateRequest("topic", "", [])).toBeNull();
  });

  test("maps each send type to the send API target fields", () => {
    expect(estimateRequest("broadcast", "", [])).toEqual({ type: "broadcast" });
    expect(estimateRequest("topic", "news", [])).toEqual({ type: "topic", target: "news" });
    expect(estimateRequest("single", "", ["u1"])).toEqual({ type: "single", target: "u1" });
    expect(estimateRequest("multi", "", ["u1", "u2"])).toEqual({ type: "multi", targets: ["u1", "u2"] });
  });
});

describe("collectWarnings", () => {
  const base = { type: "single" as const, title: "hi", body: "there", imageUrl: "", devices: 1, hasFirebase: true };

  test("is empty for a short single send", () => {
    expect(collectWarnings(base)).toEqual([]);
  });

  test("flags long title and body past the recommended length", () => {
    expect(collectWarnings({ ...base, title: "가".repeat(51), body: "b".repeat(151) })).toEqual(["titleLong", "bodyLong"]);
    expect(collectWarnings({ ...base, title: "가".repeat(50) })).toEqual([]);
  });

  test("flags broadcast, empty audience, http image and log-only projects", () => {
    expect(collectWarnings({ ...base, type: "broadcast", devices: 0, imageUrl: "http://x.dev/a.png", hasFirebase: false })).toEqual([
      "broadcast",
      "noDevices",
      "imageNotHttps",
      "logOnly",
    ]);
  });
});

test("charLength counts emoji as one character", () => {
  expect(charLength("👍🏻a")).toBe(3);
  expect(charLength("🎉a")).toBe(2);
});

test("platformEntries orders ios, android, web and drops zero counts", () => {
  expect(platformEntries({ web: 1, huawei: 2, android: 0, ios: 3 })).toEqual([["ios", 3], ["web", 1], ["huawei", 2]]);
});
