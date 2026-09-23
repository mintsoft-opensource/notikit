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

describe("built-in variables", () => {
  const now = new Date("2026-09-22T06:30:00Z"); // 서울 15:30 화요일, 뉴욕 02:30 화요일
  const ctx = { appName: "쇼핑앱", now };

  it("prefers the name field over attributes.name", () => {
    expect(renderTemplate("{{name}}", { externalId: "u", name: "김민지", attributes: { name: "옛이름" } }, ctx)).toBe("김민지");
    expect(renderTemplate("{{name}}", { externalId: "u", attributes: { name: "민지" } }, ctx)).toBe("민지");
    expect(renderTemplate("{{name|고객}}", { externalId: "u", name: null, attributes: {} }, ctx)).toBe("고객");
  });

  it("fills app_name from the context", () => {
    expect(renderTemplate("[{{app_name}}] 알림", null, ctx)).toBe("[쇼핑앱] 알림");
  });

  it("formats date, time and weekday in the recipient's timezone and locale", () => {
    const seoul = { externalId: "u", attributes: null, timezone: "Asia/Seoul", locale: "ko" };
    expect(renderTemplate("{{date}} {{weekday}} {{time}}", seoul, ctx)).toBe("9월 22일 화요일 오후 3:30");
    const ny = { externalId: "u", attributes: null, timezone: "America/New_York", locale: "en" };
    expect(renderTemplate("{{date}} {{time}}", ny, ctx)).toBe("September 22 2:30 AM");
  });

  it("falls back to UTC and Korean when the recipient has no or an invalid timezone", () => {
    const bad = { externalId: "u", attributes: null, timezone: "Mars/Olympus", locale: null };
    expect(renderTemplate("{{time}}", bad, ctx)).toBe("오전 6:30");
    expect(renderTemplate("{{date}}", null, ctx)).toBe("9월 22일");
  });

  it("lets a user attribute with a built-in name not override the built-in", () => {
    expect(renderTemplate("{{app_name}}", { externalId: "u", attributes: { app_name: "가짜" } }, ctx)).toBe("쇼핑앱");
  });
});

describe("user_id variable", () => {
  it("is the user's id, and the legacy {{external_id}} still works", () => {
    const u = { externalId: "u-42", attributes: null };
    expect(renderTemplate("{{user_id}}/{{external_id}}", u)).toBe("u-42/u-42");
  });
});

describe("locale edge cases", () => {
  const now = new Date("2026-09-22T23:00:00Z"); // 서울 9월 23일 오전 8시
  it("accepts underscore locales from Android/Flutter and keeps the timezone", () => {
    const u = { externalId: "u", attributes: null, timezone: "Asia/Seoul", locale: "ko_KR" };
    expect(renderTemplate("{{date}} {{time}}", u, { now })).toBe("9월 23일 오전 8:00");
  });
  it("keeps the timezone even when the locale is garbage", () => {
    const u = { externalId: "u", attributes: null, timezone: "Asia/Seoul", locale: "!!" };
    expect(renderTemplate("{{date}}", u, { now })).toBe("9월 23일");
  });
});

