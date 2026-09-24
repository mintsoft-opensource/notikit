import { describe, it, expect } from "vitest";
import { buildDiff, redactValue, looksLikePhone, REDACTED, baseAction, isDenied, actionFilter } from "./audit";

describe("redactValue", () => {
  it("키 이름이 비밀을 가리키면 값을 보지 않고 가린다", () => {
    const out = redactValue({
      url: "https://hook.example.com",
      secret: "whsec_abcdef",
      apiKey: "ak_live_1",
      passwordHash: "$2b$10$xyz",
      authorization: "Bearer aaa",
      identityHash: "deadbeef",
    }) as Record<string, unknown>;

    expect(out.url).toBe("https://hook.example.com");
    for (const k of ["secret", "apiKey", "passwordHash", "authorization", "identityHash"]) {
      expect(out[k]).toBe(REDACTED);
    }
  });

  it("키가 무해해도 전화번호로 보이는 값은 뒤 4자리만 남긴다", () => {
    expect(redactValue({ externalId: "+82 10-1234-5678" })).toEqual({ externalId: "[phone …5678]" });
    expect(redactValue({ externalId: "01012345678" })).toEqual({ externalId: "[phone …5678]" });
  });

  it("주문번호처럼 짧은 숫자 id 는 전화로 보지 않는다", () => {
    expect(looksLikePhone("12345678")).toBe(false);
    expect(looksLikePhone("user-42")).toBe(false);
    expect(redactValue({ externalId: "12345678" })).toEqual({ externalId: "12345678" });
  });

  it("중첩 객체와 배열 안까지 내려가며 가린다", () => {
    const out = redactValue({ webhook: { url: "https://a", secret: "s" }, entries: [{ token: "t1" }] });
    expect(out).toEqual({ webhook: { url: "https://a", secret: REDACTED }, entries: [{ token: REDACTED }] });
  });

  it("컨테이너 키 자체가 비밀을 가리키면 통째로 가린다", () => {
    // `tokens: [...]` 를 배열이라는 이유로 훑고 들어가면 원소 형태가 바뀌는 순간 새어 나간다
    expect(redactValue({ tokens: ["t1", "t2"] })).toEqual({ tokens: REDACTED });
  });

  it("긴 문자열·긴 배열·깊은 중첩을 잘라 감사 행이 무한정 커지지 않게 한다", () => {
    const long = redactValue({ body: "a".repeat(600) }) as { body: string };
    expect(long.body.length).toBeLessThan(600);
    expect(long.body.endsWith("(+88)")).toBe(true);

    const arr = redactValue({ ids: Array.from({ length: 60 }, (_, i) => i) }) as { ids: unknown[] };
    expect(arr.ids).toHaveLength(51);
    expect(arr.ids[50]).toBe("…(+10 more)");

    expect(redactValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[deep]" } } } });
  });

  it("입력을 제자리에서 고치지 않는다", () => {
    const input = { secret: "s", nested: { token: "t" } };
    redactValue(input);
    expect(input).toEqual({ secret: "s", nested: { token: "t" } });
  });
});

describe("buildDiff", () => {
  it("바뀐 필드만, 항상 before 와 after 를 함께 담는다", () => {
    const diff = buildDiff(
      { quietStartHour: 22, quietEndHour: 8, frequencyCapPerDay: 3 },
      { quietStartHour: 23, quietEndHour: 8, frequencyCapPerDay: 3 }
    );
    expect(diff).toEqual({ quietStartHour: { before: 22, after: 23 } });
  });

  it("아무것도 바뀌지 않으면 null — '수정함' 만 적힌 행을 만들지 않는다", () => {
    expect(buildDiff({ a: 1 }, { a: 1 })).toBeNull();
  });

  it("생성은 before=null, 삭제는 after=null 로 모든 필드를 남긴다", () => {
    expect(buildDiff(null, { name: "vip", rules: null })).toEqual({
      name: { before: null, after: "vip" },
      rules: { before: null, after: null },
    });
    expect(buildDiff({ name: "vip" }, null)).toEqual({ name: { before: "vip", after: null } });
  });

  it("요청이 건드리지 않은 필드(undefined)는 무시하고, 값을 비운 것(null)은 기록한다", () => {
    expect(buildDiff({ a: 1, b: 2 }, { a: undefined, b: null })).toEqual({ b: { before: 2, after: null } });
  });

  it("false 와 0 으로의 변경을 놓치지 않는다", () => {
    expect(buildDiff({ enabled: true }, { enabled: false })).toEqual({ enabled: { before: true, after: false } });
    expect(buildDiff({ cap: 5 }, { cap: 0 })).toEqual({ cap: { before: 5, after: 0 } });
  });

  it("객체 값은 내용을 비교한다 — 참조만 보면 규칙 변경이 매번 '바뀜' 으로 찍힌다", () => {
    expect(buildDiff({ rules: { a: 1 } }, { rules: { a: 1 } })).toBeNull();
    expect(buildDiff({ rules: { a: 1 } }, { rules: { a: 2 } })).not.toBeNull();
  });

  it("diff 를 거쳐도 비밀·토큰·전화번호는 저장되지 않는다", () => {
    const diff = buildDiff(
      { token: "old-token", externalId: "+821012345678" },
      { token: "new-token", externalId: "+821099998888" }
    )!;
    expect(diff.token).toEqual({ before: REDACTED, after: REDACTED });
    expect(diff.externalId).toEqual({ before: "[phone …5678]", after: "[phone …8888]" });
    expect(JSON.stringify(diff)).not.toContain("new-token");
    expect(JSON.stringify(diff)).not.toContain("821012345678");
  });
});

describe("거부된 시도 표기", () => {
  it("접미사로 성공과 거부를 구분하고, 필터 하나로 둘 다 본다", () => {
    expect(isDenied("topic.delete:denied")).toBe(true);
    expect(isDenied("topic.delete")).toBe(false);
    expect(baseAction("topic.delete:denied")).toBe("topic.delete");
    expect(actionFilter("topic.delete")).toEqual(["topic.delete", "topic.delete:denied"]);
  });
});
