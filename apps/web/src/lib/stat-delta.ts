const ROUND = 10;

/** 직전 기간 대비 증감률(%). 직전 값이 0 이면 비교할 수 없으므로 null — "+∞%" 로 위장하지 않는다 */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100 * ROUND) / ROUND;
}

/** 비율(0~1)끼리의 차이를 퍼센트포인트로. 한쪽이라도 정의되지 않으면 null */
export function ptChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return Math.round((current - previous) * 100 * ROUND) / ROUND;
}

/** 분모가 0 이면 비율이 없다 */
export function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}
