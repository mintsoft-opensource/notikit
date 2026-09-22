import { describe, it, expect } from "vitest";
import { templateSchema, buildCustomData } from "./templates";

const base = { name: "주문 도착", title: "{{name|고객}}님, 주문이 도착했어요", body: "확인해 보세요" };

describe("templateSchema", () => {
  it("accepts a template with custom fields", () => {
    const r = templateSchema.safeParse({
      ...base,
      deep_link: "myapp://order",
      fields: [
        { key: "order_id", label: "주문 번호", required: true },
        { key: "screen", default: "order" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects keys the push payload already uses", () => {
    for (const key of ["deep_link", "notikit_log_id", "title", "google.sent_time", "gcm.x", "from", "collapse_key"]) {
      expect(templateSchema.safeParse({ ...base, fields: [{ key }] }).success).toBe(false);
    }
  });

  it("rejects duplicate and malformed keys", () => {
    expect(templateSchema.safeParse({ ...base, fields: [{ key: "a" }, { key: "a" }] }).success).toBe(false);
    expect(templateSchema.safeParse({ ...base, fields: [{ key: "has space" }] }).success).toBe(false);
    expect(templateSchema.safeParse({ ...base, fields: [{ key: "1st" }] }).success).toBe(false);
  });

  it("allows an empty title/body so a template can hold only fields", () => {
    expect(templateSchema.safeParse({ name: "필드만", title: "", body: "", fields: [{ key: "k" }] }).success).toBe(true);
  });
});

describe("buildCustomData", () => {
  const fields = [
    { key: "order_id", required: true },
    { key: "screen", default: "order" },
    { key: "memo" },
  ];

  it("uses entered values, falls back to defaults and drops empty optional fields", () => {
    expect(buildCustomData(fields, { order_id: "A-1", memo: "" })).toEqual({ data: { order_id: "A-1", screen: "order" } });
  });

  it("reports missing required fields", () => {
    expect(buildCustomData(fields, { order_id: "  " })).toEqual({ missing: ["order_id"] });
  });

  it("returns no data when nothing is filled", () => {
    expect(buildCustomData([{ key: "memo" }], {})).toEqual({ data: undefined });
  });
});
