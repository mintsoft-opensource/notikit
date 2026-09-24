import { describe, it, expect } from "vitest";
import {
  AB_MIN_VARIANT_SAMPLE,
  AB_TIE_MARGIN,
  abBucket,
  abPart,
  abResults,
  abScale,
  abTargets,
  abWinnerKey,
  decideWinner,
  inAbSample,
  type AbVariantResult,
} from "./ab-test";
import { variantIndex } from "./push-variant";

const tokens = Array.from({ length: 4000 }, (_, i) => `tok-${i}-${(i * 7919) % 101}`);
const rows = tokens.map((token) => ({ token }));

describe("해시 버킷 분할", () => {
  it("버킷은 0~99 이고 같은 토큰은 언제 계산해도 같다", () => {
    for (const t of tokens.slice(0, 200)) {
      const b = abBucket(t);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
      expect(abBucket(t)).toBe(b);
    }
  });

  it("표본과 나머지가 겹치지 않고 빠짐도 없다 — 승자 발송이 표본에 두 번 가지 않는 근거", () => {
    const part = { samplePercent: 20 };
    const sample = abTargets({ part: "sample", ...part }, rows);
    const rest = abTargets({ part: "remainder", ...part }, rows);
    const inSample = new Set(sample.map((r) => r.token));
    expect(sample.length + rest.length).toBe(rows.length);
    expect(rest.some((r) => inSample.has(r.token))).toBe(false);
    expect(new Set([...sample, ...rest].map((r) => r.token)).size).toBe(rows.length);
  });

  it("표본 크기가 지정한 비율 근처다", () => {
    for (const pct of [5, 20, 50]) {
      const n = rows.filter((r) => inAbSample(r.token, pct)).length;
      expect(Math.abs(n / rows.length - pct / 100)).toBeLessThan(0.03);
    }
  });

  it("표본 안에서 변형이 고르게 나뉜다 — 버킷 해시가 변형 배정과 붙어 있으면 여기서 깨진다", () => {
    // 표본 5% · 변형 2개: 같은 해시를 %100 으로 다시 쓰면 홀짝이 3:2 로 기운다
    const sample = tokens.filter((t) => inAbSample(t, 5));
    const a = sample.filter((t) => variantIndex(t, 2) === 0).length;
    expect(sample.length).toBeGreaterThan(50);
    expect(Math.abs(a / sample.length - 0.5)).toBeLessThan(0.15);
  });

  it("설정이 없으면 대상 전체가 그대로다", () => {
    expect(abTargets(null, rows)).toBe(rows);
    expect(abPart(null)).toBeNull();
  });

  it("설정에서 이 발송이 맡은 쪽을 읽는다", () => {
    expect(abPart({ role: "test", samplePercent: 20, waitMinutes: 60, metric: "unique_click_rate" })).toEqual({
      part: "sample",
      samplePercent: 20,
    });
    expect(abPart({ role: "winner", parentLogId: "l1", samplePercent: 20, variant: 1 })).toEqual({
      part: "remainder",
      samplePercent: 20,
    });
  });

  it("분모는 맡은 쪽만큼으로 줄인다", () => {
    expect(abScale(1000, { part: "sample", samplePercent: 20 })).toBe(200);
    expect(abScale(1000, { part: "remainder", samplePercent: 20 })).toBe(800);
    expect(abScale(1000, null)).toBe(1000);
  });

  it("승자 본발송의 멱등 키는 표본 발송 id 로 정해진다 — 재판정에도 한 행", () => {
    expect(abWinnerKey("log-1")).toBe(abWinnerKey("log-1"));
    expect(abWinnerKey("log-1")).not.toBe(abWinnerKey("log-2"));
  });
});

describe("abResults", () => {
  it("발송 집계와 유니크 클릭을 변형별 한 줄로 합친다", () => {
    const r = abResults(2, { "0": { sent: 10, success: 8 }, "1": { sent: 10, success: 0 } }, new Map([[0, 2]]));
    expect(r).toEqual([
      { variant: 0, sent: 10, success: 8, clicks: 2, rate: 0.25 },
      // 도달이 0이면 0% 가 아니라 "잴 수 없음"이다
      { variant: 1, sent: 10, success: 0, clicks: 0, rate: null },
    ]);
  });

  it("집계가 없어도 변형 수만큼 줄을 만든다", () => {
    expect(abResults(2, null, new Map()).map((r) => r.success)).toEqual([0, 0]);
  });
});

/** 최소 표본을 넘긴 결과 한 줄 */
const row = (variant: number, clicks: number, success = AB_MIN_VARIANT_SAMPLE): AbVariantResult => ({
  variant,
  sent: success,
  success,
  clicks,
  rate: success > 0 ? clicks / success : null,
});

const AT = new Date("2026-09-24T03:00:00.000Z");

describe("decideWinner", () => {
  it("차이가 뚜렷하면 승자를 정한다", () => {
    const d = decideWinner([row(0, 5), row(1, 20)], AT);
    expect(d).toMatchObject({ winner: 1, reason: "winner", at: AT.toISOString() });
    expect(d.results).toHaveLength(2);
  });

  it("최소 표본을 못 채운 변형이 하나라도 있으면 승자를 말하지 않는다", () => {
    const d = decideWinner([row(0, 5), row(1, 20, AB_MIN_VARIANT_SAMPLE - 1)], AT);
    expect(d.winner).toBeNull();
    expect(d.reason).toBe("insufficient_sample");
  });

  it("도달이 0인 변형도 최소 표본 미달이다 — 0/0 을 0% 로 읽고 A 를 고르지 않는다", () => {
    expect(decideWinner([row(0, 3), row(1, 0, 0)], AT).reason).toBe("insufficient_sample");
  });

  it("변형이 하나면 비교할 것이 없다", () => {
    expect(decideWinner([row(0, 10)], AT).reason).toBe("insufficient_sample");
  });

  it("동률(차이가 가드 미만)이면 승자가 없다", () => {
    const margin = Math.round(AB_TIE_MARGIN * AB_MIN_VARIANT_SAMPLE); // 1%p = 1건
    expect(decideWinner([row(0, 10), row(1, 10)], AT).reason).toBe("tie");
    expect(decideWinner([row(0, 10), row(1, 10 + margin - 1)], AT).reason).toBe("tie");
    // 가드를 정확히 채우면 승자다
    expect(decideWinner([row(0, 10), row(1, 10 + margin)], AT)).toMatchObject({ winner: 1, reason: "winner" });
  });

  it("아무도 클릭하지 않았으면 동률이 아니라 '클릭 없음'으로 말한다", () => {
    const d = decideWinner([row(0, 0), row(1, 0)], AT);
    expect(d.winner).toBeNull();
    expect(d.reason).toBe("no_clicks");
  });

  it("판정은 순수 함수다 — 같은 입력이면 같은 결과", () => {
    const rows2 = [row(0, 5), row(1, 20)];
    expect(decideWinner(rows2, AT)).toEqual(decideWinner(rows2, AT));
  });
});
