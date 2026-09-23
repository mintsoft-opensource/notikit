import { describe, it, expect } from "vitest";
import { nextAllowedTime } from "./quiet-hours";

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("nextAllowedTime — UTC(타임존 미설정)", () => {
  it("구간 밖이면 null, 설정이 없거나 start===end 여도 null", () => {
    expect(nextAllowedTime(null, 7)).toBeNull();
    expect(nextAllowedTime(22, null)).toBeNull();
    expect(nextAllowedTime(9, 9, at("2026-03-01T09:30:00Z"))).toBeNull();
    expect(nextAllowedTime(22, 7, at("2026-03-01T12:00:00Z"))).toBeNull();
  });

  it("당일 구간은 종료 시각으로", () => {
    expect(iso(nextAllowedTime(1, 5, at("2026-03-01T03:20:00Z")))).toBe("2026-03-01T05:00:00.000Z");
  });

  it("자정 넘김 구간은 밤이면 다음 날 종료 시각, 새벽이면 당일 종료 시각", () => {
    expect(iso(nextAllowedTime(22, 7, at("2026-03-01T23:10:00Z")))).toBe("2026-03-02T07:00:00.000Z");
    expect(iso(nextAllowedTime(22, 7, at("2026-03-02T03:00:00Z")))).toBe("2026-03-02T07:00:00.000Z");
  });

  it("경계: 시작 시각은 안, 종료 시각은 밖", () => {
    expect(nextAllowedTime(22, 7, at("2026-03-01T07:00:00Z"))).toBeNull();
    expect(iso(nextAllowedTime(22, 7, at("2026-03-01T22:00:00Z")))).toBe("2026-03-02T07:00:00.000Z");
  });

  it("알 수 없는 타임존 이름은 UTC 로 본다 — 발송이 예외로 죽으면 안 된다", () => {
    expect(iso(nextAllowedTime(1, 5, at("2026-03-01T03:20:00Z"), "Mars/Olympus"))).toBe("2026-03-01T05:00:00.000Z");
    expect(iso(nextAllowedTime(1, 5, at("2026-03-01T03:20:00Z"), ""))).toBe("2026-03-01T05:00:00.000Z");
  });
});

describe("nextAllowedTime — 프로젝트 타임존", () => {
  it("현지 벽시계로 판정한다: UTC 로는 밖인 시각도 서울에서는 방해금지 안", () => {
    // 2026-03-01T22:30Z = 서울 07:30(다음 날) → 22~07 구간 밖
    expect(nextAllowedTime(22, 7, at("2026-03-01T22:30:00Z"), "Asia/Seoul")).toBeNull();
    // 2026-03-01T15:30Z = 서울 00:30 → 구간 안, 종료는 서울 07:00 = 22:00Z
    expect(iso(nextAllowedTime(22, 7, at("2026-03-01T15:30:00Z"), "Asia/Seoul"))).toBe("2026-03-01T22:00:00.000Z");
  });

  it("자정 넘김 구간: 현지 밤이면 현지 다음 날 종료 시각", () => {
    // 서울 2026-03-02 23:10 = 14:10Z → 다음 날 서울 07:00 = 2026-03-02T22:00Z
    expect(iso(nextAllowedTime(22, 7, at("2026-03-02T14:10:00Z"), "Asia/Seoul"))).toBe("2026-03-02T22:00:00.000Z");
  });

  it("30분 오프셋 타임존에서도 정각으로 떨어진다", () => {
    // 인도 +05:30, 2026-03-01T20:00Z = 01:30 IST(다음 날) → 종료 05:00 IST = 23:30Z
    expect(iso(nextAllowedTime(23, 5, at("2026-03-01T20:00:00Z"), "Asia/Kolkata"))).toBe("2026-03-01T23:30:00.000Z");
  });

  it("서머타임 시작(뉴욕 2026-03-08): 건너뛴 한 시간만큼 실제 대기가 줄어든다", () => {
    // 01:30 EST(-5) = 06:30Z, 종료 04:00 EDT(-4) = 08:00Z → 벽시계 2시간 30분이지만 실제 1시간 30분
    const end = nextAllowedTime(1, 4, at("2026-03-08T06:30:00Z"), "America/New_York");
    expect(iso(end)).toBe("2026-03-08T08:00:00.000Z");
  });

  it("서머타임 시작으로 사라진 종료 시각(02:00)은 전환 직후(03:00 EDT)로 민다", () => {
    // 01:30 EST = 06:30Z. 02:00 은 존재하지 않는 벽시계 → 03:00 EDT = 07:00Z
    const end = nextAllowedTime(1, 2, at("2026-03-08T06:30:00Z"), "America/New_York");
    expect(iso(end)).toBe("2026-03-08T07:00:00.000Z");
    expect(end!.getTime()).toBeGreaterThan(at("2026-03-08T06:30:00Z").getTime());
  });

  it("서머타임 종료(뉴욕 2026-11-01): 반복되는 한 시간만큼 방해금지가 길어진다", () => {
    // 01:00 EDT(-4) = 05:00Z, 종료 02:00 EST(-5) = 07:00Z → 실제 2시간
    expect(iso(nextAllowedTime(23, 2, at("2026-11-01T05:00:00Z"), "America/New_York"))).toBe("2026-11-01T07:00:00.000Z");
  });

  it("서머타임 종료일 밤: 다음 날 종료 시각도 현지 오프셋으로 계산한다", () => {
    // 2026-10-31 23:30 EDT = 2026-11-01T03:30Z → 종료 07:00 EST(-5) = 2026-11-01T12:00Z
    expect(iso(nextAllowedTime(22, 7, at("2026-11-01T03:30:00Z"), "America/New_York"))).toBe("2026-11-01T12:00:00.000Z");
  });

  it("월말·연말을 넘겨도 다음 날 종료 시각을 만든다", () => {
    // 서울 2026-12-31 23:30 = 14:30Z → 2027-01-01 07:00 KST = 2026-12-31T22:00Z
    expect(iso(nextAllowedTime(22, 7, at("2026-12-31T14:30:00Z"), "Asia/Seoul"))).toBe("2026-12-31T22:00:00.000Z");
  });
});
