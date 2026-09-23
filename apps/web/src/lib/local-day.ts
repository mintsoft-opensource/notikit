const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 사용자가 고른 날짜(YYYY-MM-DD) → 그날 브라우저 로컬 자정의 UTC ISO.
 *
 * 오늘의 `getTimezoneOffset()` 을 모든 날짜에 쓰면 서머타임 경계를 넘는 날이 한 시간 어긋난다.
 * 그래서 날짜마다 `new Date(y, m, d)` 로 그날의 오프셋을 따로 구한다.
 * `endExclusive` 면 다음날 자정 — 조회 범위의 `to` 는 미포함 경계다.
 */
export function localDayBoundaryIso(date: string, endExclusive = false): string | null {
  const m = DATE_ONLY.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const local = new Date(y, mo, d + (endExclusive ? 1 : 0));
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}
