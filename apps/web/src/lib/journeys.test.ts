import { describe, it, expect } from "vitest";
import { stepCounts } from "./journeys";
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
