/**
 * 방해금지 시간대 — 프로젝트 타임존의 **벽시계**로 판정한다.
 *
 * UTC 로만 보면 한국 프로젝트의 "22시~07시"가 실제로는 현지 07시~16시를 막는다.
 * 운영자가 콘솔에 적은 시각은 언제나 자기 서비스의 시각이므로, 판정도 종료 시각 계산도
 * 그 타임존에서 해야 한다. `timeZone` 이 없거나 런타임이 모르는 이름이면 UTC — 기존 동작 그대로.
 */

const UTC = "UTC";

/** 어떤 타임존에서 본 벽시계 값 */
export type Wall = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** 타임존 이름이 틀리면 null. 사용자가 넣은 값이라 검증 없이 쓰면 발송 전체가 예외로 죽는다. */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    fmt = null;
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

/** 그 타임존에서 본 연·월·일·시·분. 분까지 봐야 +05:30(인도) 같은 오프셋이 맞는다. */
function wallClock(fmt: Intl.DateTimeFormat, at: Date): Wall {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // 일부 런타임은 자정을 24 로 준다
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

function wallAsUtcMs(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/** 그 시각에 이 타임존이 UTC 와 벌어진 간격(ms) */
function offsetAt(fmt: Intl.DateTimeFormat, at: Date): number {
  const floored = Math.floor(at.getTime() / 60_000) * 60_000;
  return wallAsUtcMs(wallClock(fmt, at)) - floored;
}

/**
 * 벽시계 → 실제 시각. 오프셋을 두 번 재서 서머타임 경계에서도 맞춘다 —
 * 한 번만 재면 경계 **직전**의 오프셋으로 경계 **이후**의 시각을 계산해 한 시간 어긋난다.
 */
function fromWallClock(fmt: Intl.DateTimeFormat, w: Wall): Date {
  const target = wallAsUtcMs(w);
  const first = target - offsetAt(fmt, new Date(target));
  return new Date(target - offsetAt(fmt, new Date(first)));
}

/**
 * 그 타임존에서 본 지금(또는 주어진 시각)의 벽시계. 타임존 이름이 틀리면 UTC 로 본다.
 * 반복 예약처럼 "그 지역의 몇 시"를 다루는 쪽이 이 파일의 DST 처리를 그대로 쓰라고 내보낸다.
 */
export function wallClockIn(timeZone: string | null | undefined, at = new Date()): Wall {
  return wallClock(formatterFor(timeZone || UTC) ?? formatterFor(UTC)!, at);
}

/**
 * 벽시계 → 실제 시각. 오프셋을 두 번 재서 서머타임 경계에서도 맞는다 —
 * 한 번만 재면 경계 직전의 오프셋으로 경계 이후의 시각을 계산해 한 시간 어긋난다.
 * 서머타임 시작으로 **사라진** 시각이면 `null` 이 아니라 그 벽시계가 가리키는 가장 가까운 실제 시각이다.
 */
export function dateFromWallClock(timeZone: string | null | undefined, w: Wall): Date {
  return fromWallClock(formatterFor(timeZone || UTC) ?? formatterFor(UTC)!, w);
}

/**
 * 그 시각 그 타임존의 UTC 오프셋 딱지(예: "+09:00", "-03:30").
 *
 * 현지 시각 발송이 묶음 키로 쓴다. IANA 이름 대신 오프셋으로 묶는 이유: 이름은 수백 개인데
 * "지금 현지 몇 시인가"는 오프셋만으로 정해져, 같은 오프셋 묶음은 **동시에** 발송 시각이 된다.
 * 서머타임도 그 시점에 재므로 자동으로 따라간다. 이름이 틀리면 UTC 취급("+00:00").
 */
export function zoneOffsetLabel(timeZone: string | null | undefined, at = new Date()): string {
  const fmt = formatterFor(timeZone || UTC) ?? formatterFor(UTC)!;
  const minutes = Math.round(offsetAt(fmt, at) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * 현재가 [start, end) 구간이면 종료 시각(Date), 아니면 null.
 * start<end: 당일 구간. start>end: 자정 넘김.
 */
export function nextAllowedTime(
  startHour: number | null,
  endHour: number | null,
  now = new Date(),
  timeZone?: string | null
): Date | null {
  if (startHour === null || endHour === null || startHour === endHour) return null;
  const fmt = formatterFor(timeZone || UTC) ?? formatterFor(UTC)!;

  const w = wallClock(fmt, now);
  const inWindow = startHour < endHour ? w.hour >= startHour && w.hour < endHour : w.hour >= startHour || w.hour < endHour;
  if (!inWindow) return null;

  const end = endOfQuiet(fmt, w, endHour);
  // 오늘의 종료 시각이 이미 지났으면(자정 넘김 구간의 밤 쪽) 다음 날 종료 시각이다
  return end.getTime() > now.getTime() ? end : endOfQuiet(fmt, { ...w, day: w.day + 1 }, endHour);
}

/**
 * 그 날짜의 종료 시각. 서머타임 시작으로 **사라진** 시각(예: 02:00)이면 전환 직후로 민다 —
 * 오지 않는 벽시계로 예약하면 발송이 한 시간 일찍(=아직 방해금지 중) 나간다.
 */
function endOfQuiet(fmt: Intl.DateTimeFormat, day: Wall, endHour: number): Date {
  const at = fromWallClock(fmt, { ...day, hour: endHour, minute: 0 });
  if (wallClock(fmt, at).hour === endHour % 24) return at;
  return fromWallClock(fmt, { ...day, hour: endHour + 1, minute: 0 });
}
