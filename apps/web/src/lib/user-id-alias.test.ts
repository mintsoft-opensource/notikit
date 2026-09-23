import { describe, it, expect } from "vitest";
import { applyUserIdAlias, userIdParam } from "./user-id-alias";

describe("applyUserIdAlias", () => {
  it("maps user_id to external_id", () => {
    expect(applyUserIdAlias({ user_id: "u-1", name: "a" })).toEqual({ external_id: "u-1", name: "a" });
  });

  it("keeps null so unbinding with user_id: null still works", () => {
    expect(applyUserIdAlias({ user_id: null, token: "t" })).toEqual({ external_id: null, token: "t" });
  });

  it("leaves legacy external_id requests untouched", () => {
    const body = { external_id: "u-1" };
    expect(applyUserIdAlias(body)).toEqual({ external_id: "u-1" });
  });

  it("lets user_id win when both are sent", () => {
    expect(applyUserIdAlias({ user_id: "u-1", external_id: "u-2" })).toEqual({ external_id: "u-1" });
  });

  it("ignores non-objects", () => {
    expect(applyUserIdAlias([1])).toEqual([1]);
    expect(applyUserIdAlias("x")).toBe("x");
    expect(applyUserIdAlias(null)).toBeNull();
  });
});

describe("userIdParam", () => {
  it("reads user_id first, then external_id", () => {
    expect(userIdParam(new URLSearchParams("user_id=a&external_id=b"))).toBe("a");
    expect(userIdParam(new URLSearchParams("external_id=b"))).toBe("b");
    expect(userIdParam(new URLSearchParams(""))).toBeNull();
  });
});
