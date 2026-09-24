import { describe, it, expect } from "vitest";
import { conversionLift, holdoutKey, inHoldout, splitHoldout, HOLDOUT_MAX, HOLDOUT_MIN } from "./holdout";
import { abBucket, inAbSample } from "./ab-test";

const rows = Array.from({ length: 4000 }, (_, i) => ({ token: `tok-${i}`, userId: `user-${i}` }));

describe("홀드아웃 배정", () => {
  it("같은 사람은 언제 계산해도 같은 쪽이다 — 발송마다 다시 뽑으면 숫자가 의미를 잃는다", () => {
    const row = { token: "tok-1", userId: "user-1" };
    const first = inHoldout(row, 20);
    for (let i = 0; i < 50; i++) expect(inHoldout(row, 20)).toBe(first);
    // 기기를 바꿔도 사람이 같으면 같은 쪽에 남는다
    expect(inHoldout({ token: "다른-토큰", userId: "user-1" }, 20)).toBe(first);
  });

  it("사람이 없는 익명 기기는 토큰으로 고정한다", () => {
    expect(holdoutKey({ token: "t", userId: null })).not.toBe(holdoutKey({ token: "t", userId: "u" }));
    const anon = { token: "anon-1", userId: null };
    expect(inHoldout(anon, 30)).toBe(inHoldout({ ...anon }, 30));
  });

  it("비율이 없거나 0 이면 아무도 빠지지 않는다", () => {
    expect(splitHoldout(rows, null).held).toHaveLength(0);
    expect(splitHoldout(rows, 0).held).toHaveLength(0);
    expect(splitHoldout(rows, undefined).send).toHaveLength(rows.length);
  });

  it("대략 비율만큼 빠지고, 뺀 것과 보낼 것이 서로소다", () => {
    const { send, held } = splitHoldout(rows, 20);
    expect(send.length + held.length).toBe(rows.length);
    expect(held.length / rows.length).toBeGreaterThan(0.15);
    expect(held.length / rows.length).toBeLessThan(0.25);
    const heldTokens = new Set(held.map((r) => r.token));
    expect(send.some((r) => heldTokens.has(r.token))).toBe(false);
  });

  it("A/B 표본 버킷과 붙지 않는다 — 붙으면 '표본에 든 사람이 늘 대조군'이 된다", () => {
    // 해시 키에 접두사를 붙이지 않으면 두 축이 같은 버킷을 써서 상관계수가 1 이 된다
    const both = rows.filter((r) => inAbSample(r.token, 50) && inHoldout(r, 50)).length;
    const sample = rows.filter((r) => inAbSample(r.token, 50)).length;
    // 독립이면 표본 중 대조군은 절반 근처여야 한다(같은 해시면 100% 나 0% 가 나온다)
    expect(both / sample).toBeGreaterThan(0.4);
    expect(both / sample).toBeLessThan(0.6);
  });

  it("버킷은 0~99 라 비율이 그대로 백분율이다", () => {
    expect(abBucket(holdoutKey(rows[0]))).toBeGreaterThanOrEqual(0);
    expect(abBucket(holdoutKey(rows[0]))).toBeLessThan(100);
    expect(HOLDOUT_MIN).toBe(1);
    expect(HOLDOUT_MAX).toBe(50);
  });
});

describe("리프트", () => {
  it("대조군 전환율 대비 얼마나 올랐는지", () => {
    expect(conversionLift({ converted: 20, total: 100 }, { converted: 10, total: 100 })).toBeCloseTo(1);
    expect(conversionLift({ converted: 5, total: 100 }, { converted: 10, total: 100 })).toBeCloseTo(-0.5);
  });

  it("대조군 전환이 0 이면 비율이 성립하지 않아 null — 0% 나 무한대로 적지 않는다", () => {
    expect(conversionLift({ converted: 20, total: 100 }, { converted: 0, total: 100 })).toBeNull();
    expect(conversionLift({ converted: 20, total: 100 }, { converted: 1, total: 0 })).toBeNull();
    expect(conversionLift({ converted: 0, total: 0 }, { converted: 1, total: 10 })).toBeNull();
  });
});
