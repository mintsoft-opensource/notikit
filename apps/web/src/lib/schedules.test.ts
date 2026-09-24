import { describe, it, expect } from "vitest";
import {
  CATCH_UP_GRACE_MS,
  nextOccurrence,
  occurrenceKey,
  planScheduleTick,
  previousOccurrence,
  type Recurrence,
  type ScheduleState,
} from "@/lib/schedules";

const daily = (hour: number, minute = 0): Recurrence => ({ kind: "daily", hour, minute });
const weekly = (weekday: number, hour: number): Recurrence => ({ kind: "weekly", weekday, hour, minute: 0 });
const monthly = (dayOfMonth: number, hour: number): Recurrence => ({ kind: "monthly", dayOfMonth, hour, minute: 0 });
const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("nextOccurrence", () => {
  it("매일 — 오늘 시각이 지났으면 다음 날이다", () => {
    // 서울 09:30 → 오늘 09:00 은 이미 지났다
    expect(iso(nextOccurrence(daily(9), at("2026-09-24T00:30:00Z"), "Asia/Seoul"))).toBe("2026-09-25T00:00:00.000Z");
  });

  it("매일 — 오늘 시각이 아직이면 오늘이다", () => {
    expect(iso(nextOccurrence(daily(9), at("2026-09-23T23:30:00Z"), "Asia/Seoul"))).toBe("2026-09-24T00:00:00.000Z");
  });

  it("정각과 같은 순간은 이미 지난 것으로 본다 (같은 회차를 두 번 잡지 않게)", () => {
    const exact = at("2026-09-24T09:00:00Z");
    expect(iso(nextOccurrence(daily(9), exact, "UTC"))).toBe("2026-09-25T09:00:00.000Z");
  });

  it("타임존 이름이 틀리면 UTC 로 본다 (예외로 워커를 죽이지 않는다)", () => {
    expect(iso(nextOccurrence(daily(9), at("2026-09-24T10:00:00Z"), "Not/AZone"))).toBe("2026-09-25T09:00:00.000Z");
  });

  it("매주 — 지정 요일에만 잡힌다", () => {
    // 2026-09-24 는 목요일, weekday=1 은 월요일
    const next = nextOccurrence(weekly(1, 9), at("2026-09-24T00:00:00Z"), "UTC");
    expect(next.getUTCDay()).toBe(1);
    expect(iso(next)).toBe("2026-09-28T09:00:00.000Z");
  });
});

describe("nextOccurrence — 서머타임", () => {
  it("벽시계 09:00 을 유지한다 (봄 전환일은 간격이 23시간)", () => {
    const tz = "America/New_York";
    const before = nextOccurrence(daily(9), at("2026-03-06T20:00:00Z"), tz); // 3/7 09:00 EST
    const after = nextOccurrence(daily(9), before, tz); // 3/8 09:00 EDT
    expect(iso(before)).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(after)).toBe("2026-03-08T13:00:00.000Z");
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  it("봄 전환으로 사라진 시각(02:30)은 전환 직후로 민다 — 한 시간 일찍 나가지 않게", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT. 02:30 은 존재하지 않는다.
    const next = nextOccurrence(daily(2, 30), at("2026-03-07T12:00:00Z"), "America/New_York");
    expect(iso(next)).toBe("2026-03-08T07:30:00.000Z"); // = 03:30 EDT
  });

  it("가을 전환으로 두 번 오는 시각(01:30)은 한 번만 잡는다", () => {
    const tz = "America/New_York";
    const first = nextOccurrence(daily(1, 30), at("2026-11-01T03:00:00Z"), tz);
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z"); // 첫 번째 01:30 (EDT)
    // 두 번째 01:30(EST, 06:30Z)을 또 잡지 않고 다음 날로 넘어간다
    expect(iso(nextOccurrence(daily(1, 30), first, tz))).toBe("2026-11-02T06:30:00.000Z");
  });
});

describe("nextOccurrence — 월말", () => {
  it("28일 예약은 2월에도 그대로 28일이다", () => {
    expect(iso(nextOccurrence(monthly(28, 9), at("2026-01-31T00:00:00Z"), "UTC"))).toBe("2026-02-28T09:00:00.000Z");
  });

  it("31일이 저장돼 있으면 그 달의 말일로 당긴다 — 짧은 달을 조용히 건너뛰지 않게", () => {
    expect(iso(nextOccurrence(monthly(31, 9), at("2026-02-01T00:00:00Z"), "UTC"))).toBe("2026-02-28T09:00:00.000Z");
    expect(iso(nextOccurrence(monthly(31, 9), at("2026-04-01T00:00:00Z"), "UTC"))).toBe("2026-04-30T09:00:00.000Z");
  });

  it("윤년 2월은 29일까지 간다", () => {
    expect(iso(nextOccurrence(monthly(31, 9), at("2028-02-01T00:00:00Z"), "UTC"))).toBe("2028-02-29T09:00:00.000Z");
  });

  it("12월 다음은 이듬해 1월이다", () => {
    expect(iso(nextOccurrence(monthly(15, 9), at("2026-12-20T00:00:00Z"), "UTC"))).toBe("2027-01-15T09:00:00.000Z");
  });
});

describe("previousOccurrence", () => {
  it("지금 시각 이전의 가장 가까운 회차", () => {
    expect(iso(previousOccurrence(daily(9), at("2026-09-24T18:00:00Z"), "UTC"))).toBe("2026-09-24T09:00:00.000Z");
    expect(iso(previousOccurrence(daily(9), at("2026-09-24T08:00:00Z"), "UTC"))).toBe("2026-09-23T09:00:00.000Z");
  });

  it("정각 자신을 포함한다", () => {
    expect(iso(previousOccurrence(daily(9), at("2026-09-24T09:00:00Z"), "UTC"))).toBe("2026-09-24T09:00:00.000Z");
  });
});

const base: ScheduleState = { ...daily(9), enabled: true, nextRunAt: null, lastRunAt: null };

describe("planScheduleTick", () => {
  it("아직 도래 전이면 아무것도 하지 않고 도래 시각도 그대로 둔다", () => {
    const nextRunAt = at("2026-09-24T09:00:00Z");
    const plan = planScheduleTick({ ...base, nextRunAt }, at("2026-09-24T08:59:00Z"), "UTC");
    expect(plan.fire).toBeNull();
    expect(plan.skipped).toBe(0);
    expect(plan.nextRunAt).toBe(nextRunAt); // 불필요한 UPDATE 를 만들지 않게 같은 값 그대로
  });

  it("도래했으면 그 회차를 보내고 다음 회차를 잡는다", () => {
    const plan = planScheduleTick(
      { ...base, nextRunAt: at("2026-09-24T09:00:00Z") },
      at("2026-09-24T09:00:07Z"),
      "UTC"
    );
    expect(iso(plan.fire)).toBe("2026-09-24T09:00:00.000Z");
    expect(plan.skipped).toBe(0);
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("다운타임 뒤 — 밀린 회차를 몰아 보내지 않고 가장 최근 것 하나만 보낸다", () => {
    // 9/22·9/23 회차를 놓친 채 9/24 09:05 에 워커가 살아났다
    const plan = planScheduleTick(
      { ...base, nextRunAt: at("2026-09-22T09:00:00Z") },
      at("2026-09-24T09:05:00Z"),
      "UTC"
    );
    expect(iso(plan.fire)).toBe("2026-09-24T09:00:00.000Z");
    expect(plan.skipped).toBe(2);
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("다운타임 뒤 — 유예를 넘겼으면 한 건도 보내지 않는다", () => {
    // 09시 푸시를 18시에 보내는 것은 안 보내느니만 못하다
    const plan = planScheduleTick(
      { ...base, nextRunAt: at("2026-09-22T09:00:00Z") },
      at("2026-09-24T18:00:00Z"),
      "UTC"
    );
    expect(plan.fire).toBeNull();
    expect(plan.skipped).toBe(3);
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("유예 경계 — 딱 15분까지는 보내고 그 뒤로는 보내지 않는다", () => {
    const occurrence = at("2026-09-24T09:00:00Z");
    const edge = planScheduleTick(
      { ...base, nextRunAt: occurrence },
      new Date(occurrence.getTime() + CATCH_UP_GRACE_MS),
      "UTC"
    );
    const past = planScheduleTick(
      { ...base, nextRunAt: occurrence },
      new Date(occurrence.getTime() + CATCH_UP_GRACE_MS + 1000),
      "UTC"
    );
    expect(iso(edge.fire)).toBe("2026-09-24T09:00:00.000Z");
    expect(past.fire).toBeNull();
  });

  it("이미 보낸 회차는 다시 보내지 않고 '놓친 회차'로도 세지 않는다", () => {
    const plan = planScheduleTick(
      { ...base, nextRunAt: at("2026-09-24T09:00:00Z"), lastRunAt: at("2026-09-24T09:00:00Z") },
      at("2026-09-24T09:00:30Z"),
      "UTC"
    );
    expect(plan.fire).toBeNull();
    expect(plan.skipped).toBe(0);
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("꺼진 예약은 보내지 않고 도래 시각만 지금 기준으로 다시 잡는다", () => {
    const plan = planScheduleTick(
      { ...base, enabled: false, nextRunAt: at("2026-09-22T09:00:00Z") },
      at("2026-09-24T09:05:00Z"),
      "UTC"
    );
    expect(plan.fire).toBeNull();
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("도래 시각이 비어 있으면 처음 한 번은 보내지 않고 시각만 채운다", () => {
    const plan = planScheduleTick({ ...base, nextRunAt: null }, at("2026-09-24T10:00:00Z"), "UTC");
    expect(plan.fire).toBeNull();
    expect(iso(plan.nextRunAt)).toBe("2026-09-25T09:00:00.000Z");
  });

  it("주간 예약도 서머타임 경계에서 벽시계를 유지한다", () => {
    const tz = "America/New_York";
    const sunday = weekly(0, 9);
    const plan = planScheduleTick(
      { ...sunday, enabled: true, nextRunAt: at("2026-03-01T14:00:00Z"), lastRunAt: null },
      at("2026-03-01T14:00:05Z"),
      tz
    );
    // 다음 일요일(3/8)은 EDT — UTC 로는 한 시간 당겨진 13:00
    expect(iso(plan.nextRunAt)).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("occurrenceKey", () => {
  it("예약 id + 회차 — 같은 회차는 언제 계산해도 같은 키다", () => {
    const id = "3f1c0f7e-0000-4000-8000-000000000001";
    expect(occurrenceKey(id, at("2026-09-24T09:00:00Z"))).toBe(`${id}:2026-09-24T09:00:00.000Z`);
    // Idempotency-Key 규칙(출력 가능한 ASCII 1~255자)을 지킨다
    expect(occurrenceKey(id, at("2026-09-24T09:00:00Z"))).toMatch(/^[\x21-\x7e]{1,255}$/);
  });

  it("회차가 다르면 키도 다르다 — 이틀치가 한 건으로 합쳐지지 않게", () => {
    const id = "3f1c0f7e-0000-4000-8000-000000000001";
    expect(occurrenceKey(id, at("2026-09-24T09:00:00Z"))).not.toBe(occurrenceKey(id, at("2026-09-25T09:00:00Z")));
  });
});
