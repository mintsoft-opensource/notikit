import { describe, it, expect } from "vitest";
import {
  closeLocalPass,
  localDueAt,
  offsetMinutes,
  openLocalPass,
  parseLocalTime,
  passState,
  splitDue,
  type LocalState,
} from "./local-delivery";

const NINE = { hour: 9, minute: 0 };
/** 2026-09-24 03:00 UTC = 서울 12:00 · 런던 04:00 · 뉴욕 23:00(전날) */
const NOW = new Date("2026-09-24T03:00:00.000Z");

const dev = (token: string) => ({ token });

describe("parseLocalTime", () => {
  it("HH:MM 만 받는다 — 틀린 값으로 발송 전체를 미루면 안 된다", () => {
    expect(parseLocalTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseLocalTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("9:00")).toBeNull();
    expect(parseLocalTime(null)).toBeNull();
  });
});

describe("localDueAt", () => {
  it("오프셋 묶음의 그날 현지 시각을 실제 시각으로 돌려준다", () => {
    expect(offsetMinutes("+09:00")).toBe(540);
    expect(offsetMinutes("-03:30")).toBe(-210);
    // 서울 09:00 = 00:00 UTC (이미 지났다)
    expect(new Date(localDueAt("+09:00", NINE, NOW)).toISOString()).toBe("2026-09-24T00:00:00.000Z");
    // 런던 09:00 = 08:00 UTC (아직)
    expect(new Date(localDueAt("+01:00", NINE, NOW)).toISOString()).toBe("2026-09-24T08:00:00.000Z");
  });
});

describe("splitDue", () => {
  const zones: Record<string, string> = { a: "Asia/Seoul", b: "Europe/London", c: "Asia/Seoul" };
  const rows = [dev("a"), dev("b"), dev("c")];
  const zoneOf = (r: { token: string }) => zones[r.token];

  it("시각이 된 시간대만 보내고 나머지는 가장 이른 도래 시각으로 미룬다", () => {
    const pass = openLocalPass(NINE, undefined, NOW, false);
    const { send, deferred } = splitDue(pass, rows, zoneOf);
    expect(send.map((r) => r.token)).toEqual(["a", "c"]);
    expect(deferred).toBe(1);
    expect(closeLocalPass(pass)).toEqual({
      sentOffsets: ["+09:00"],
      passAt: null,
      nextPassAt: "2026-09-24T08:00:00.000Z",
    });
  });

  it("지난 회차에 보낸 묶음은 건너뛴다 — 커서를 되돌려 다시 훑어도 두 번 가지 않는다", () => {
    const prev: LocalState = { sentOffsets: ["+09:00"], passAt: null, nextPassAt: null };
    const later = new Date("2026-09-24T08:00:00.000Z"); // 런던 09:00
    const pass = openLocalPass(NINE, prev, later, false);
    const { send } = splitDue(pass, rows, zoneOf);
    expect(send.map((r) => r.token)).toEqual(["b"]);
    expect(closeLocalPass(pass).sentOffsets).toEqual(["+01:00", "+09:00"]);
  });

  it("하루 창이 지나면 남은 묶음도 즉시 보낸다 — 이틀 뒤 도착하는 알림은 알림이 아니다", () => {
    const pass = openLocalPass(NINE, undefined, NOW, true);
    const { send, deferred } = splitDue(pass, rows, zoneOf);
    expect(send).toHaveLength(3);
    expect(deferred).toBe(0);
    expect(closeLocalPass(pass).nextPassAt).toBeNull();
  });

  it("시간대를 모르는 기기는 UTC 로 본다 — 판정 불가로 빠뜨리지 않는다", () => {
    const pass = openLocalPass(NINE, undefined, NOW, false);
    // UTC 03:00 은 아직 09:00 이 아니다
    expect(splitDue(pass, [dev("x")], () => null).send).toEqual([]);
    expect(pass.deferAt).toBe(Date.parse("2026-09-24T09:00:00.000Z"));
  });

  it("회차 중간에 이어받아도 이번 회차에 보낸 묶음과 미룬 시각을 잃지 않는다", () => {
    // 1쪽: 서울은 보내고 런던은 미룬 채 죽었다
    const first = openLocalPass(NINE, undefined, NOW, false);
    splitDue(first, [dev("a"), dev("b")], zoneOf);
    const mid = passState(first);

    // 2쪽(서울 한 대)만 남은 채로 이어받아 회차를 닫는다
    const resumed = openLocalPass(NINE, mid, NOW, false);
    splitDue(resumed, [dev("c")], zoneOf);
    // 1쪽에서 보낸 서울이 빠지면 다음 회차에서 또 보내고, 미룬 런던 시각이 빠지면 런던은 영영 못 받는다
    expect(closeLocalPass(resumed)).toEqual({
      sentOffsets: ["+09:00"],
      passAt: null,
      nextPassAt: "2026-09-24T08:00:00.000Z",
    });
  });

  it("미룬 묶음만 남은 쪽에서 이어받아도 다음 회차 시각이 남는다", () => {
    const first = openLocalPass(NINE, undefined, NOW, false);
    splitDue(first, [dev("b")], zoneOf);
    const resumed = openLocalPass(NINE, passState(first), NOW, false);
    splitDue(resumed, [], zoneOf);
    expect(closeLocalPass(resumed).nextPassAt).toBe("2026-09-24T08:00:00.000Z");
  });

  it("회차 기준 시각은 이어받아도 고정된다 — 회차 중간에 새로 도래한 묶음이 생기면 앞쪽을 건너뛴다", () => {
    const first = openLocalPass(NINE, undefined, NOW, false);
    splitDue(first, rows, zoneOf);
    const mid = passState(first);
    expect(mid.passAt).toBe(NOW.toISOString());

    // 런던이 09:00 을 넘긴 뒤 이어받아도 같은 회차는 여전히 서울만 보낸다
    const resumed = openLocalPass(NINE, mid, new Date("2026-09-24T09:00:00.000Z"), false);
    expect(splitDue(resumed, rows, zoneOf).send.map((r) => r.token)).toEqual(["a", "c"]);
  });
});
