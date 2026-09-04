/**
 * 방해금지 시간대 계산 (UTC). 현재가 [start, end) 구간이면 종료 시각(Date) 반환, 아니면 null.
 * start<end: 당일 구간. start>end: 자정 넘김.
 */
export function nextAllowedTime(startHour: number | null, endHour: number | null, now = new Date()): Date | null {
  if (startHour === null || endHour === null || startHour === endHour) return null;
  const h = now.getUTCHours();
  const inWindow = startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
  if (!inWindow) return null;

  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(endHour);
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
