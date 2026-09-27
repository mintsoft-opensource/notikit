import { describe, it, expect } from "vitest";
import { stepCounts, stepFunnel, type StepSendAgg } from "./journeys";
import { compileJourney, type JourneyStep } from "./journey-triggers";

const tree: JourneyStep[] = [
  { type: "entry", event: "signup" },
  { type: "send", title: "welcome", body: "hi" },
  { type: "wait", hours: 24 },
  {
    type: "branch",
    withinHours: 24,
    yes: [{ type: "exit", event: "purchase" }],
    no: [{ type: "send", title: "nudge", body: "still there?" }],
  },
];

describe("stepCounts", () => {
  const program = compileJourney(tree);

  it("lists every step in the tree, including the ones nobody is on", () => {
    // 0 인 스텝이 빠지면 화면에서 그 갈래가 통째로 사라져, 분기가 존재하는지도 알 수 없다
    expect(stepCounts(program, [])).toEqual({ "1": 0, "2": 0, "3": 0, "3.yes.0": 0, "3.no.0": 0 });
  });

  it("counts runs at their current program counter, by tree path", () => {
    const runs = [{ currentStep: 0 }, { currentStep: 1 }, { currentStep: 1 }, { currentStep: 4 }];
    expect(stepCounts(program, runs)).toEqual({ "1": 1, "2": 2, "3": 0, "3.yes.0": 0, "3.no.0": 1 });
  });

  it("ignores counters past the end of the program", () => {
    // 완료된 실행의 PC 는 명령 배열 길이와 같다 — 스텝에 얹으면 마지막 스텝 인원이 부풀고,
    // 운영자는 아무도 없는 스텝에 사람이 묶여 있다고 읽는다
    const runs = [{ currentStep: program.instructions.length }, { currentStep: 99 }, { currentStep: -1 }];
    expect(stepCounts(program, runs)).toEqual({ "1": 0, "2": 0, "3": 0, "3.yes.0": 0, "3.no.0": 0 });
  });
});

describe("stepFunnel", () => {
  const program = compileJourney(tree);
  const waiting = stepCounts(program, [{ currentStep: 1 }, { currentStep: 1 }, { currentStep: 4 }]);

  it("keeps a line for every step, even the ones that never sent", () => {
    const rows = stepFunnel(program, waiting, []);
    expect(rows.map((r) => r.path)).toEqual(["1", "2", "3", "3.yes.0", "3.no.0"]);
    // 발송이 없던 스텝은 0 이다 — 줄을 빼면 분기 아래 갈래가 화면에서 통째로 사라진다
    expect(rows.every((r) => r.sent === 0 && r.clicks === 0 && r.conversions === 0)).toBe(true);
  });

  it("carries waiting from the runs and sent/clicks from the send attribution", () => {
    const sends: StepSendAgg[] = [
      { stepPath: "1", sent: 100, clicks: 25, conversions: 4 },
      { stepPath: "3.no.0", sent: 40, clicks: 2, conversions: 0 },
    ];
    const byPath = Object.fromEntries(stepFunnel(program, waiting, sends).map((r) => [r.path, r]));
    // 머문 수(현재)와 발송 수(누적)는 출처가 다르다 — 서로 덮어쓰지 않아야 한다.
    // 첫 스텝은 아무도 머물지 않지만 100건을 보냈고("지나갔다"), 대기 스텝은 그 반대다.
    expect(byPath["1"]).toMatchObject({ waiting: 0, sent: 100, clicks: 25, conversions: 4 });
    expect(byPath["2"]).toMatchObject({ waiting: 2, sent: 0, clicks: 0 });
    expect(byPath["3.no.0"]).toMatchObject({ waiting: 1, sent: 40, clicks: 2 });
  });

  it("sums repeated rows for the same step instead of keeping only the last", () => {
    // 한 스텝이 실행마다 로그 1건을 낸다. 덮어쓰면 수천 건 발송이 마지막 한 건으로 보인다.
    const sends: StepSendAgg[] = [
      { stepPath: "1", sent: 10, clicks: 1, conversions: 0 },
      { stepPath: "1", sent: 7, clicks: 3, conversions: 2 },
    ];
    const row = stepFunnel(program, waiting, sends).find((r) => r.path === "1");
    expect(row).toMatchObject({ sent: 17, clicks: 4, conversions: 2 });
  });

  it("drops rows with no step path instead of crediting them to a step", () => {
    // journey_id 는 있는데 step_path 가 비어 있는 과거 행(마이그레이션 이전)이 여기로 온다
    const rows = stepFunnel(program, waiting, [{ stepPath: null, sent: 999, clicks: 999, conversions: 9 }]);
    expect(rows.reduce((n, r) => n + r.sent, 0)).toBe(0);
  });

  it("reports the step kind so the console can label the line", () => {
    const kinds = stepFunnel(program, waiting, []).map((r) => r.kind);
    expect(kinds).toEqual(["send", "wait", "branch", "exit", "send"]);
  });
});
