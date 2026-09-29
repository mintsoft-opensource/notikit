/**
 * 저니 스텝 트리 — 순수 로직만. 콘솔(클라이언트)도 import 하므로 DB 를 끌어오면 안 된다.
 * DB 를 쓰는 진입·종료 훅은 journey-triggers.ts 에 있다.
 */
import { z } from "zod";

/**
 * 트리거 저니 — 트리 스텝 · 분기 · 종료 조건.
 *
 * ## 왜 트리를 평탄화하는가
 * `journey_runs.current_step` 은 정수 하나다. 트리를 그대로 들고 다니려면 "2.yes.0" 같은
 * 경로 컬럼이 필요하지만, 그러면 진행을 원자적으로 집는 CAS(`current_step` 조건 advance)를
 * 새로 짜야 한다 — 중복 발송을 막는 유일한 장치다.
 *
 * 그래서 저장은 트리로 하고, 실행 직전에 **전위 순회로 평탄화한 명령 배열**로 컴파일한다.
 * `current_step` 은 그 배열의 프로그램 카운터가 된다. 분기는 yes/no 목표 인덱스를 들고
 * 점프하고, 블록 끝은 합류 지점으로 떨어진다. 기존 CAS·유니크 등록·트랜잭션 발송이 그대로 산다.
 *
 * 컴파일은 순수 함수라 스텝 트리만 있으면 테스트도 DB 없이 된다.
 *
 * ## 한계 (마이그레이션이 필요한 지점)
 * 운영자가 트리를 고치면 이미 중간에 있는 실행의 PC 가 다른 명령을 가리킨다. 지금도 같은
 * 문제라 화면이 경고를 띄운다(`activeRunsWarning`). 경로 컬럼이 생기면 사라진다.
 */

export type SendStep = { type: "send"; title?: string; body?: string };
export type WaitStep = { type: "wait"; hours?: number };
export type BranchStep = { type: "branch"; withinHours?: number; yes?: JourneyStep[]; no?: JourneyStep[] };
export type ExitStep = { type: "exit"; event?: string };
/**
 * 진입 트리거. 노드지만 실행되지 않는다 — 트리 맨 앞(`steps[0]`)에서 "이 이벤트가 오면 등록"만
 * 선언한다. 전용 컬럼(`journeys.entry_event`)이 없어 jsonb 안에 둔다.
 */
export type EntryStep = { type: "entry"; event?: string };

export type JourneyStep = SendStep | WaitStep | BranchStep | ExitStep | EntryStep;

export const STEP_TYPES = ["send", "wait", "branch", "exit", "entry"] as const;

/** 분기 대기창 기본값(시간) — "이전 발송을 N시간 안에 눌렀나" */
export const DEFAULT_BRANCH_HOURS = 24;
export const MAX_BRANCH_HOURS = 24 * 30;
/** 트리 전체 노드 수 상한 — 한 실행이 도는 명령 수를 묶는다 */
export const MAX_STEP_NODES = 40;
/** 분기 중첩 깊이 상한. 1 이면 분기 안에 분기를 넣을 수 없다. */
export const MAX_BRANCH_DEPTH = 3;

/** 이벤트 엔드포인트가 아닌 경로에서 오는 예약 이벤트 이름 */
export const EVENT_IDENTIFY = "$identify";
export const EVENT_CLICK = "$click";

// ─── 컴파일 ──────────────────────────────────────────────────────────────────

export type Instruction =
  | { kind: "send"; path: string; step: SendStep; next: number }
  | { kind: "wait"; path: string; hours: number; next: number }
  | { kind: "branch"; path: string; withinHours: number; yes: number; no: number }
  | { kind: "exit"; path: string; event: string; next: number };

export type Program = {
  instructions: Instruction[];
  /** 트리 어디에든 있는 exit 노드의 이벤트 이름 — 등록 이후 **언제든** 검사한다 */
  exitEvents: string[];
  entryEvent: string | null;
};

type Fixup = { at: number; field: "next" | "yes" | "no" };

function patch(out: Instruction[], f: Fixup, target: number): void {
  const instr = out[f.at];
  if (f.field === "next" && instr.kind !== "branch") instr.next = target;
  else if (f.field === "yes" && instr.kind === "branch") instr.yes = target;
  else if (f.field === "no" && instr.kind === "branch") instr.no = target;
}

/**
 * 목록 하나를 명령 배열 뒤에 이어 붙인다.
 *
 * 반환하는 `tails` 는 "이 목록을 빠져나간 뒤 갈 곳"이 아직 안 정해진 자리들이다. 분기의 두
 * 갈래가 모두 여기에 모여 바깥 합류 지점으로 한 번에 메워진다 — 블록을 다 찍기 전에는 합류
 * 인덱스를 알 수 없어서(뒤에 뭐가 더 붙을지 모른다) 나중에 메우는 방식이 필요하다.
 */
function emitList(out: Instruction[], nodes: JourneyStep[], prefix: string): { start: number | null; tails: Fixup[] } {
  let start: number | null = null;
  let pending: Fixup[] = [];

  nodes.forEach((node, i) => {
    if (node.type === "entry") return; // 선언만 — 실행 명령이 아니다
    const path = prefix ? `${prefix}.${i}` : String(i);
    const at = out.length;
    let tails: Fixup[];

    if (node.type === "branch") {
      out.push({ kind: "branch", path, withinHours: clampHours(node.withinHours), yes: -1, no: -1 });
      const yes = emitList(out, node.yes ?? [], `${path}.yes`);
      const no = emitList(out, node.no ?? [], `${path}.no`);
      tails = [...yes.tails, ...no.tails];
      // 빈 갈래는 자기 자리를 합류 지점으로 넘긴다 — 아무것도 안 하고 바로 빠져나간다
      if (yes.start === null) tails.push({ at, field: "yes" });
      else patch(out, { at, field: "yes" }, yes.start);
      if (no.start === null) tails.push({ at, field: "no" });
      else patch(out, { at, field: "no" }, no.start);
    } else if (node.type === "send") {
      out.push({ kind: "send", path, step: { type: "send", title: node.title, body: node.body }, next: -1 });
      tails = [{ at, field: "next" }];
    } else if (node.type === "wait") {
      out.push({ kind: "wait", path, hours: Math.max(0, Math.floor(node.hours ?? 0)), next: -1 });
      tails = [{ at, field: "next" }];
    } else {
      out.push({ kind: "exit", path, event: node.event ?? "", next: -1 });
      tails = [{ at, field: "next" }];
    }

    if (start === null) start = at;
    for (const f of pending) patch(out, f, at);
    pending = tails;
  });

  return { start, tails: pending };
}

function clampHours(h: number | undefined): number {
  const n = Math.floor(h ?? DEFAULT_BRANCH_HOURS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BRANCH_HOURS;
  return Math.min(n, MAX_BRANCH_HOURS);
}

function collect(nodes: JourneyStep[], out: string[]): void {
  for (const n of nodes) {
    if (n.type === "exit") {
      if (n.event && !out.includes(n.event)) out.push(n.event);
    } else if (n.type === "branch") {
      collect(n.yes ?? [], out);
      collect(n.no ?? [], out);
    }
  }
}

/** 스텝 트리 → 실행 프로그램. PC 가 `instructions.length` 면 끝난 것이다. */
export function compileJourney(steps: JourneyStep[]): Program {
  const nodes = normalizeSteps(steps);
  const instructions: Instruction[] = [];
  const { tails } = emitList(instructions, nodes, "");
  // 남은 자리는 전부 프로그램 끝(= 완료)으로
  for (const f of tails) patch(instructions, f, instructions.length);
  const exitEvents: string[] = [];
  collect(nodes, exitEvents);
  return { instructions, exitEvents, entryEvent: entryEventOf(nodes) };
}

/**
 * 저장된 값을 트리로 되맞춘다.
 *
 * 분기 이전에 저장된 행은 `{type:'send'|'wait'}` 평탄 목록이고 `yes`/`no` 가 없다. 그대로
 * 컴파일하면 되지만, 알 수 없는 타입(앞으로 생길 노드)이 섞여 들어와 실행이 멈추는 일은
 * 막아야 한다 — 모르는 노드는 버린다.
 */
export function normalizeSteps(steps: unknown): JourneyStep[] {
  if (!Array.isArray(steps)) return [];
  const out: JourneyStep[] = [];
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (s.type === "send") out.push({ type: "send", title: str(s.title), body: str(s.body) });
    else if (s.type === "wait") out.push({ type: "wait", hours: num(s.hours) });
    else if (s.type === "exit") out.push({ type: "exit", event: str(s.event) });
    else if (s.type === "entry") out.push({ type: "entry", event: str(s.event) });
    else if (s.type === "branch") {
      out.push({
        type: "branch",
        withinHours: num(s.withinHours),
        yes: normalizeSteps(s.yes),
        no: normalizeSteps(s.no),
      });
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 진입 트리거 이벤트 — 트리 맨 앞의 entry 노드에서만 읽는다 */
export function entryEventOf(steps: JourneyStep[]): string | null {
  const head = steps[0];
  return head && head.type === "entry" && head.event ? head.event : null;
}

/**
 * 이 저니를 움직이는 이벤트 이름 전부(진입 + 종료, 중복 없이). `journeys.trigger_events` 에
 * 저장해, 이벤트가 들어올 때 프로젝트의 저니를 전부 읽지 않고 걸린 것만 고른다.
 */
export function triggerEventsOf(steps: JourneyStep[]): string[] {
  const { entryEvent, exitEvents } = compileJourney(steps);
  return [...new Set([...(entryEvent ? [entryEvent] : []), ...exitEvents])];
}

/** 트리 앞에 진입 트리거를 넣거나(있으면 교체) 뺀다 */
export function withEntryEvent(steps: JourneyStep[], event: string | null): JourneyStep[] {
  const rest = steps[0]?.type === "entry" ? steps.slice(1) : steps;
  return event ? [{ type: "entry", event }, ...rest] : rest;
}

/** 노드 수 — 상한 검사용 (entry 포함) */
export function countNodes(steps: JourneyStep[]): number {
  let n = 0;
  for (const s of steps) {
    n += 1;
    if (s.type === "branch") n += countNodes(s.yes ?? []) + countNodes(s.no ?? []);
  }
  return n;
}

/** 분기 중첩 깊이 */
export function branchDepth(steps: JourneyStep[]): number {
  let d = 0;
  for (const s of steps) {
    if (s.type !== "branch") continue;
    d = Math.max(d, 1 + Math.max(branchDepth(s.yes ?? []), branchDepth(s.no ?? [])));
  }
  return d;
}

// ─── 입력 검증 ───────────────────────────────────────────────────────────────

/**
 * 이벤트 이름 — 전환 엔드포인트가 받는 규칙과 **같아야** 한다. 여기서만 넓으면 콘솔에서는
 * 저장되는데 실제로는 그 이름의 이벤트가 들어올 수 없는 저니가 만들어진다.
 */
export const eventNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}]+$/u, "event must not contain control characters");

// 제목·본문 모두 필수다. 발송기(finalizeMessage)는 둘 중 하나라도 비면 그 스텝을 건너뛰는데,
// 저장 때 받아 주면 "저장됨"이 뜬 저니가 실제로는 아무에게도 보내지 않는다.
const sendSchema = z.object({
  type: z.literal("send"),
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(4000),
});
const waitSchema = z.object({
  type: z.literal("wait"),
  hours: z.number().int().min(0).max(24 * 365).optional(),
});
const exitSchema = z.object({ type: z.literal("exit"), event: eventNameSchema });
const entrySchema = z.object({ type: z.literal("entry"), event: eventNameSchema });

const branchSchema: z.ZodType<BranchStep> = z.lazy(() =>
  z.object({
    type: z.literal("branch"),
    withinHours: z.number().int().min(1).max(MAX_BRANCH_HOURS).optional(),
    yes: z.array(stepSchema).max(MAX_STEP_NODES).optional(),
    no: z.array(stepSchema).max(MAX_STEP_NODES).optional(),
  })
);

const stepSchema: z.ZodType<JourneyStep> = z.lazy(() =>
  z.union([sendSchema, waitSchema, exitSchema, entrySchema, branchSchema])
);

/**
 * 저장되는 스텝 트리.
 *
 * 상한이 두 겹이다: 노드 총수는 한 실행이 도는 명령 수를, 중첩 깊이는 화면이 들여쓰기로
 * 감당할 수 있는 범위를 묶는다. 배열 길이만 재면 분기 안에 분기를 채워 둘 다 뚫린다.
 */
export const journeyStepsSchema = z
  .array(stepSchema)
  .min(1)
  .max(MAX_STEP_NODES)
  .superRefine((steps, ctx) => {
    if (countNodes(steps) > MAX_STEP_NODES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `steps must not exceed ${MAX_STEP_NODES} nodes` });
    }
    if (branchDepth(steps) > MAX_BRANCH_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `branches must not nest deeper than ${MAX_BRANCH_DEPTH}` });
    }
    // entry 는 트리 맨 앞에서만 읽힌다(entryEventOf). 다른 자리에 있으면 아무 일도 하지
    // 않는데 화면에는 트리거가 걸린 것처럼 보인다 — 조용히 안 도는 저니가 된다.
    if (steps.some((s, i) => s.type === "entry" && i !== 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entry trigger must be the first step" });
    }
    if (compileJourney(steps).instructions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "journey must have at least one runnable step" });
    }
  });

// ─── 분기 판정 ───────────────────────────────────────────────────────────────

/** 분기가 보는 "직전 발송" — 보낸 시각과 (있다면) 그 사람이 누른 시각 */
export type LastSend = { sentAt: Date; clickedAt: Date | null };

export type BranchDecision = { go: "yes" | "no" } | { defer: Date };

/**
 * "직전 발송을 N시간 안에 눌렀나".
 *
 * 창이 아직 안 닫혔는데 클릭이 없으면 **미루고**(defer) 창이 닫히는 시각에 다시 본다.
 * 여기서 바로 no 로 보내면 저니가 대기 스텝보다 빨리 돌 때 "아직 누를 시간이 있는" 사람이
 * 전부 no 갈래로 떨어진다 — 분기가 사실상 항상 no 가 되어 쓸모가 없어진다.
 */
export function branchDecision(last: LastSend | null, withinHours: number, now: Date): BranchDecision {
  if (!last) return { go: "no" }; // 보낸 게 없으면 누를 것도 없다
  const deadline = new Date(last.sentAt.getTime() + clampHours(withinHours) * 3_600_000);
  if (last.clickedAt && last.clickedAt.getTime() <= deadline.getTime()) return { go: "yes" };
  if (now.getTime() >= deadline.getTime()) return { go: "no" };
  return { defer: deadline };
}

// ─── 한 스텝 계획 ────────────────────────────────────────────────────────────

export type StepPlan =
  | { action: "end"; reason: "completed" | "exited"; event?: string }
  | { action: "advance"; pc: number; at: Date; send?: SendStep }
  | { action: "defer"; at: Date };

export type PlanContext = {
  now: Date;
  /** 등록 이후 그 이름의 이벤트가 있었나 */
  hasEvent: (name: string) => boolean;
  lastSend: LastSend | null;
};

/**
 * 종료 조건 — 트리 어디에 있든 등록 시점부터 검사한다.
 *
 * exit 노드가 "그 자리에 도달했을 때만" 보는 값이면, 전환한 사람이 대기 스텝에 묶여 있는
 * 동안 계속 다음 발송을 받는다. 이 기능의 목적("한 일을 또 재촉하지 않기")이 그 순간 사라진다.
 */
export function exitedBy(program: Program, hasEvent: (name: string) => boolean): string | null {
  for (const name of program.exitEvents) if (name && hasEvent(name)) return name;
  return null;
}

/** 프로그램 카운터 하나를 어떻게 진행할지 — 순수. DB 조회 결과는 ctx 로 받는다. */
export function planStep(program: Program, pc: number, ctx: PlanContext): StepPlan {
  const exited = exitedBy(program, ctx.hasEvent);
  if (exited) return { action: "end", reason: "exited", event: exited };

  const instr = program.instructions[pc];
  if (!instr) return { action: "end", reason: "completed" };

  if (instr.kind === "send") return { action: "advance", pc: instr.next, at: ctx.now, send: instr.step };
  if (instr.kind === "wait") {
    return { action: "advance", pc: instr.next, at: new Date(ctx.now.getTime() + instr.hours * 3_600_000) };
  }
  if (instr.kind === "exit") {
    // 노드에 도달했을 때도 한 번 더 본다 — 위 검사와 같은 답이지만, 이름이 빈 노드는 통과시킨다
    if (instr.event && ctx.hasEvent(instr.event)) return { action: "end", reason: "exited", event: instr.event };
    return { action: "advance", pc: instr.next, at: ctx.now };
  }

  const d = branchDecision(ctx.lastSend, instr.withinHours, ctx.now);
  if ("defer" in d) return { action: "defer", at: d.defer };
  return { action: "advance", pc: d.go === "yes" ? instr.yes : instr.no, at: ctx.now };
}

/** PC → 트리 경로. 화면의 스텝별 인원 집계 키. */
export function pathOf(program: Program, pc: number): string | null {
  return program.instructions[pc]?.path ?? null;
}
