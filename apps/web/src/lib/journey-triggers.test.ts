import { describe, it, expect } from "vitest";
import {
  branchDecision,
  branchDepth,
  compileJourney,
  countNodes,
  entryEventOf,
  exitedBy,
  normalizeSteps,
  pathOf,
  planStep,
  withEntryEvent,
  type JourneyStep,
} from "./journey-triggers";

const send = (title: string): JourneyStep => ({ type: "send", title, body: title });
const wait = (hours: number): JourneyStep => ({ type: "wait", hours });
const NOW = new Date("2026-09-24T12:00:00Z");
const never = () => false;

describe("compileJourney", () => {
  it("flattens a linear list and ends by running off the end", () => {
    const p = compileJourney([send("a"), wait(3), send("b")]);
    expect(p.instructions.map((i) => i.kind)).toEqual(["send", "wait", "send"]);
    expect(p.instructions.map((i) => (i.kind === "branch" ? -1 : i.next))).toEqual([1, 2, 3]);
    expect(p.instructions.length).toBe(3);
  });

  it("gives both branch arms a jump target and rejoins after the branch", () => {
    const p = compileJourney([
      send("first"),
      { type: "branch", withinHours: 12, yes: [send("clicked")], no: [wait(24), send("nudge")] },
      send("last"),
    ]);
    expect(p.instructions.map((i) => i.path)).toEqual(["0", "1", "1.yes.0", "1.no.0", "1.no.1", "2"]);

    const branch = p.instructions[1];
    if (branch.kind !== "branch") throw new Error("expected branch");
    expect(branch.withinHours).toBe(12);
    expect(branch.yes).toBe(2); // 1.yes.0
    expect(branch.no).toBe(3); // 1.no.0

    // 두 갈래 모두 분기 다음 스텝("2")으로 합류한다 — 한쪽만 이어지면 그 갈래는 조용히 끝난다
    const yesTail = p.instructions[2];
    const noTail = p.instructions[4];
    if (yesTail.kind === "branch" || noTail.kind === "branch") throw new Error("expected leaf");
    expect(yesTail.next).toBe(5);
    expect(noTail.next).toBe(5);
  });

  it("sends an empty arm straight to the join point instead of off the end", () => {
    const p = compileJourney([{ type: "branch", yes: [], no: [send("nudge")] }, send("after")]);
    const branch = p.instructions[0];
    if (branch.kind !== "branch") throw new Error("expected branch");
    expect(branch.no).toBe(1); // 1.no 의 발송
    expect(branch.yes).toBe(2); // 비어 있으면 합류 지점("after")으로
    expect(p.instructions[2].path).toBe("1");
  });

  it("nests branches without crossing the arms' join points", () => {
    const p = compileJourney([
      {
        type: "branch",
        yes: [{ type: "branch", yes: [send("yy")], no: [send("yn")] }],
        no: [send("n")],
      },
      send("end"),
    ]);
    expect(p.instructions.map((i) => i.path)).toEqual(["0", "0.yes.0", "0.yes.0.yes.0", "0.yes.0.no.0", "0.no.0", "1"]);
    const inner = p.instructions[1];
    if (inner.kind !== "branch") throw new Error("expected branch");
    // 안쪽 분기의 두 갈래는 **바깥 분기의 합류 지점**("1")으로 나간다
    const yy = p.instructions[2];
    const yn = p.instructions[3];
    if (yy.kind === "branch" || yn.kind === "branch") throw new Error("expected leaf");
    expect(yy.next).toBe(5);
    expect(yn.next).toBe(5);
  });

  it("collects exit events from every depth and keeps the entry trigger out of the program", () => {
    const p = compileJourney([
      { type: "entry", event: "signup" },
      send("welcome"),
      { type: "branch", yes: [{ type: "exit", event: "purchase" }], no: [send("nudge")] },
    ]);
    expect(p.entryEvent).toBe("signup");
    expect(p.exitEvents).toEqual(["purchase"]);
    // entry 는 명령이 아니다 — 첫 명령은 welcome 발송
    expect(p.instructions[0].kind).toBe("send");
    expect(p.instructions[0].path).toBe("1");
  });
});

describe("normalizeSteps", () => {
  it("keeps pre-branch rows working (flat list, no ids, no arms)", () => {
    const legacy = [{ type: "send", title: "hi", body: "there" }, { type: "wait", hours: 24 }];
    const p = compileJourney(normalizeSteps(legacy));
    expect(p.instructions.map((i) => i.kind)).toEqual(["send", "wait"]);
    expect(p.exitEvents).toEqual([]);
    expect(p.entryEvent).toBeNull();
  });

  it("drops unknown node types instead of stalling the run", () => {
    const steps = normalizeSteps([{ type: "send", title: "a" }, { type: "teleport" }, null, "x", { type: "wait", hours: 2 }]);
    expect(steps.map((s) => s.type)).toEqual(["send", "wait"]);
  });

  it("counts nodes and branch depth through the arms", () => {
    const tree: JourneyStep[] = [send("a"), { type: "branch", yes: [{ type: "branch", yes: [send("b")], no: [] }], no: [send("c")] }];
    expect(countNodes(tree)).toBe(5);
    expect(branchDepth(tree)).toBe(2);
  });
});

describe("entry trigger", () => {
  it("reads and replaces the trigger only at the head of the tree", () => {
    const steps: JourneyStep[] = [send("a")];
    expect(entryEventOf(steps)).toBeNull();
    const withEntry = withEntryEvent(steps, "signup");
    expect(entryEventOf(withEntry)).toBe("signup");
    expect(withEntry).toHaveLength(2);
    // 교체는 쌓이지 않는다
    const swapped = withEntryEvent(withEntry, "trial_started");
    expect(swapped).toHaveLength(2);
    expect(entryEventOf(swapped)).toBe("trial_started");
    expect(withEntryEvent(swapped, null)).toEqual(steps);
  });

  it("ignores an entry node that is not at the head", () => {
    expect(entryEventOf([send("a"), { type: "entry", event: "signup" }])).toBeNull();
  });
});

describe("branchDecision", () => {
  const sentAt = new Date("2026-09-24T00:00:00Z");

  it("takes the yes arm when the click landed inside the window", () => {
    expect(branchDecision({ sentAt, clickedAt: new Date("2026-09-24T05:00:00Z") }, 12, NOW)).toEqual({ go: "yes" });
  });

  it("takes the no arm once the window has closed with no click", () => {
    expect(branchDecision({ sentAt, clickedAt: null }, 6, NOW)).toEqual({ go: "no" });
  });

  it("defers instead of answering no while the window is still open", () => {
    // 창이 12시간, 지금은 발송 2시간 뒤 — 아직 누를 시간이 남았다
    const now = new Date("2026-09-24T02:00:00Z");
    expect(branchDecision({ sentAt, clickedAt: null }, 12, now)).toEqual({ defer: new Date("2026-09-24T12:00:00Z") });
  });

  it("treats a click after the window closed as no", () => {
    expect(branchDecision({ sentAt, clickedAt: new Date("2026-09-24T09:00:00Z") }, 6, NOW)).toEqual({ go: "no" });
  });

  it("answers no when nothing was ever sent", () => {
    expect(branchDecision(null, 12, NOW)).toEqual({ go: "no" });
  });
});

describe("planStep", () => {
  const tree: JourneyStep[] = [
    send("welcome"),
    wait(24),
    { type: "branch", withinHours: 24, yes: [send("thanks")], no: [send("nudge")] },
    { type: "exit", event: "purchase" },
    send("last"),
  ];
  const program = compileJourney(tree);

  it("walks a whole run down the no arm and finishes", () => {
    const sentAt = new Date("2026-09-24T00:00:00Z");
    const seen: string[] = [];
    let pc = 0;
    let now = NOW;
    for (let i = 0; i < 10; i++) {
      const plan = planStep(program, pc, { now, hasEvent: never, lastSend: { sentAt, clickedAt: null } });
      if (plan.action === "end") {
        seen.push(`end:${plan.reason}`);
        break;
      }
      if (plan.action === "defer") {
        now = plan.at;
        continue;
      }
      seen.push(pathOf(program, pc) ?? "?");
      pc = plan.pc;
      now = plan.at;
    }
    expect(seen).toEqual(["0", "1", "2", "2.no.0", "3", "4", "end:completed"]);
  });

  it("walks the yes arm when the previous send was clicked", () => {
    const lastSend = { sentAt: new Date("2026-09-24T00:00:00Z"), clickedAt: new Date("2026-09-24T01:00:00Z") };
    const plan = planStep(program, 2, { now: NOW, hasEvent: never, lastSend });
    expect(plan).toMatchObject({ action: "advance", pc: 3 });
    expect(pathOf(program, 3)).toBe("2.yes.0");
  });

  it("advances a wait by its own hours, not by the tick", () => {
    const plan = planStep(program, 1, { now: NOW, hasEvent: never, lastSend: null });
    expect(plan).toMatchObject({ action: "advance", pc: 2, at: new Date("2026-09-25T12:00:00Z") });
  });

  it("hands the send body to the caller only on send steps", () => {
    const plan = planStep(program, 0, { now: NOW, hasEvent: never, lastSend: null });
    expect(plan).toMatchObject({ action: "advance", send: { title: "welcome", body: "welcome" } });
    expect(planStep(program, 1, { now: NOW, hasEvent: never, lastSend: null })).not.toHaveProperty("send");
  });

  it("ends the run from any step once the exit event has happened", () => {
    const hasEvent = (n: string) => n === "purchase";
    // 종료 조건은 exit 노드에 **도달하기 전에도** 듣는다 — 대기 중에 전환한 사람을 더 재촉하지 않는다
    for (const pc of [0, 1, 2, 4]) {
      expect(planStep(program, pc, { now: NOW, hasEvent, lastSend: null })).toEqual({
        action: "end",
        reason: "exited",
        event: "purchase",
      });
    }
  });

  it("passes through the exit step when the event has not happened", () => {
    const plan = planStep(program, 5, { now: NOW, hasEvent: never, lastSend: null });
    expect(plan).toMatchObject({ action: "advance", pc: 6 });
  });

  it("defers the branch rather than dropping the run into the no arm early", () => {
    const lastSend = { sentAt: new Date("2026-09-24T06:00:00Z"), clickedAt: null };
    expect(planStep(program, 2, { now: NOW, hasEvent: never, lastSend })).toEqual({
      action: "defer",
      at: new Date("2026-09-25T06:00:00Z"),
    });
  });

  it("completes when the counter is past the last instruction", () => {
    expect(planStep(program, 99, { now: NOW, hasEvent: never, lastSend: null })).toEqual({
      action: "end",
      reason: "completed",
    });
  });
});

describe("exitedBy", () => {
  it("returns the first declared event that happened", () => {
    const program = compileJourney([{ type: "exit", event: "purchase" }, { type: "exit", event: "subscribed" }]);
    expect(exitedBy(program, (n) => n === "subscribed")).toBe("subscribed");
    expect(exitedBy(program, never)).toBeNull();
  });

  it("ignores exit nodes with no event name", () => {
    const program = compileJourney([{ type: "exit" }]);
    expect(program.exitEvents).toEqual([]);
    expect(exitedBy(program, () => true)).toBeNull();
  });
});
