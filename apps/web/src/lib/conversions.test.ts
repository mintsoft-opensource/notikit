import { describe, it, expect } from "vitest";
import { attributionCutoff, conversionEventSchema, isAttributable, CONVERSION_WINDOW_MS, VALUE_CENTS_MAX } from "./conversions";
import { variantForToken, variantIndex } from "./push-variant";
import { applyUserIdAlias } from "./user-id-alias";

const now = new Date("2026-03-01T12:00:00Z");

describe("전환 귀속 창", () => {
  it("cutoff 는 정확히 24시간 전", () => {
    expect(attributionCutoff(now).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(CONVERSION_WINDOW_MS).toBe(86_400_000);
  });

  it("창 안의 클릭만 귀속한다 — 경계(정확히 24시간 전)는 밖", () => {
    expect(isAttributable(new Date(now.getTime() - 1), now)).toBe(true);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS + 1), now)).toBe(true);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS), now)).toBe(false);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS - 1), now)).toBe(false);
  });
});

describe("conversionEventSchema", () => {
  // 라우트는 applyUserIdAlias 를 거친 본문을 파싱한다 — 공개 이름 user_id 는 여기서 external_id 다
  const parse = (body: unknown) => conversionEventSchema.safeParse(applyUserIdAlias(body));

  it("token 과 user_id 중 정확히 하나만 받는다", () => {
    expect(parse({ name: "purchase", token: "t1" }).success).toBe(true);
    expect(parse({ name: "purchase", user_id: "u1", identity_hash: "h" }).success).toBe(true);
    expect(parse({ name: "purchase" }).success).toBe(false);
    expect(parse({ name: "purchase", token: "t1", user_id: "u1" }).success).toBe(false);
  });

  it("예전 이름 external_id 로 보내도 같게 동작한다", () => {
    expect(parse({ name: "purchase", external_id: "u1", identity_hash: "h" }).success).toBe(true);
    expect(parse({ name: "purchase", token: "t1", external_id: "u1" }).success).toBe(false);
  });

  it("이름은 공백을 떼고 1~64자, 금액은 0 이상 정수", () => {
    const r = parse({ name: "  purchase  ", token: "t1" });
    expect(r.success && r.data.name).toBe("purchase");
    expect(parse({ name: "   ", token: "t1" }).success).toBe(false);
    expect(parse({ name: "x".repeat(65), token: "t1" }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: -1 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: 1.5 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: VALUE_CENTS_MAX + 1 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: 0 }).success).toBe(true);
  });
});

describe("variantForToken", () => {
  it("변형이 없는 발송이면 null", () => {
    expect(variantForToken("tok", null)).toBeNull();
    expect(variantForToken("tok", 0)).toBeNull();
    expect(variantForToken("tok", undefined)).toBeNull();
  });

  it("클릭에 기록하는 변형은 발송이 배정한 것과 같다", () => {
    for (const token of ["a", "tok-1", "가나다", "x".repeat(200)]) {
      expect(variantForToken(token, 2)).toBe(variantIndex(token, 2));
      expect(variantForToken(token, 3)).toBe(variantIndex(token, 3));
    }
  });

  it("같은 토큰은 항상 같은 변형 — 재클레임으로 이어 보내도 뒤집히지 않는다", () => {
    expect(variantForToken("tok", 2)).toBe(variantForToken("tok", 2));
    expect(variantForToken("tok", 2)).toBeLessThan(2);
  });
});
