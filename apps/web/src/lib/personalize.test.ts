import { describe, it, expect } from "vitest";
import { hasPlaceholders, renderTemplate } from "./personalize";

const user = { externalId: "u-1", attributes: { name: "민지", plan: "pro", visits: 3, vip: true } };

describe("renderTemplate", () => {
  it("replaces attribute placeholders with the user's values", () => {
    expect(renderTemplate("{{name}}님, {{plan}} 혜택", user)).toBe("민지님, pro 혜택");
  });

  it("exposes external_id as a built-in variable", () => {
    expect(renderTemplate("id={{external_id}}", user)).toBe("id=u-1");
  });

  it("stringifies numbers and booleans", () => {
    expect(renderTemplate("{{visits}}/{{vip}}", user)).toBe("3/true");
  });

  it("uses the fallback when the value is missing or empty", () => {
    expect(renderTemplate("{{nickname|고객}}님", user)).toBe("고객님");
    expect(renderTemplate("{{nickname|고객}}님", { externalId: "x", attributes: { nickname: "" } })).toBe("고객님");
  });

  it("renders missing values without fallback as empty", () => {
    expect(renderTemplate("안녕하세요 {{nickname}}님", user)).toBe("안녕하세요 님");
  });

  it("treats anonymous recipients as having no attributes", () => {
    expect(renderTemplate("{{name|고객}} {{external_id}}", null)).toBe("고객 ");
  });

  it("tolerates spaces inside the braces", () => {
    expect(renderTemplate("{{ name | 고객 }}", user)).toBe("민지");
  });

  it("does not render nested objects as [object Object]", () => {
    expect(renderTemplate("{{meta|없음}}", { externalId: "x", attributes: { meta: { a: 1 } } })).toBe("없음");
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderTemplate("그냥 {문자} {{", user)).toBe("그냥 {문자} {{");
  });
});

describe("hasPlaceholders", () => {
  it("detects placeholders in any of the given strings", () => {
    expect(hasPlaceholders("hi", "{{name}}")).toBe(true);
    expect(hasPlaceholders("hi", "there", null)).toBe(false);
  });
});
