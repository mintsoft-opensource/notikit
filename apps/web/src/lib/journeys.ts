import { and, asc, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, projects, pushUsers } from "@/db/schema";
import { enqueuePush, finalizeMessage } from "@/lib/messages";
import { errorMessage, log } from "@/lib/logger";
import {
  compileJourney,
  conversionsSince,
  lastJourneySend,
  normalizeSteps,
  planStep,
  type Instruction,
  type Program,
} from "@/lib/journey-triggers";

/**
 * 저니 실행 1건을 한 스텝 진행. **원자적 CAS**(currentStep 조건 advance)로 동시 처리 중복 방지:
 * advance 가 성공(1행)한 처리기만 같은 트랜잭션 안에서 발송을 큐잉한다.
 *
 * 스텝은 트리지만 실행 직전에 평탄한 명령 배열로 컴파일된다(`journey-triggers.ts`).
 * `currentStep` 은 그 배열의 프로그램 카운터라, 분기가 생겨도 CAS 는 정수 비교 그대로다.
 */
export async function processJourneyRun(runId: string): Promise<void> {
  const db = getDb();
  const run = (await db.select().from(journeyRuns).where(eq(journeyRuns.id, runId)).limit(1))[0];
  if (!run || run.status !== "active") return;

  // 저니는 같은 프로젝트 것만 (테넌트 일관성)
  const journey = (
    await db.select().from(journeys).where(and(eq(journeys.id, run.journeyId), eq(journeys.projectId, run.projectId))).limit(1)
  )[0];
  if (!journey) {
    await db.update(journeyRuns).set({ status: "completed" }).where(eq(journeyRuns.id, runId));
    return;
  }

  const program = compileJourney(normalizeSteps(journey.steps));
  const instr: Instruction | undefined = program.instructions[run.currentStep];

  const user = (
    await db
      .select({ externalId: pushUsers.externalId })
      .from(pushUsers)
      .where(and(eq(pushUsers.id, run.userId), eq(pushUsers.projectId, run.projectId)))
      .limit(1)
  )[0];

  // 판정에 필요한 DB 조회는 트랜잭션 **밖에서** 한 번에 모은다 — 분기가 로그·클릭을 훑는
  // 동안 트랜잭션을 열어 두면 advance 를 기다리는 다른 처리기까지 같이 묶인다.
  const enrolledAt = run.createdAt;
  const converted = await conversionsSince(db, run.projectId, run.userId, program.exitEvents, enrolledAt);
  const lastSend =
    instr?.kind === "branch" && user
      ? await lastJourneySend(db, run.projectId, run.journeyId, run.userId, user.externalId, enrolledAt)
      : null;

  const plan = planStep(program, run.currentStep, {
    now: new Date(),
    hasEvent: (name) => converted.has(name),
    lastSend,
  });

  if (plan.action === "end") {
    await db
      .update(journeyRuns)
      .set({ status: plan.reason })
      .where(and(eq(journeyRuns.id, runId), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)));
    return;
  }

  if (plan.action === "defer") {
    // 분기 창이 아직 안 닫혔다 — PC 는 그대로 두고 닫히는 시각에 다시 본다.
    // currentStep 조건을 그대로 걸어 둔다: 그사이 다른 처리기가 진행시켰으면 건드리지 않는다.
    await db
      .update(journeyRuns)
      .set({ nextRunAt: plan.at })
      .where(and(eq(journeyRuns.id, runId), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)));
    return;
  }

  const done = plan.pc >= program.instructions.length;

  // advance 와 발송 큐잉을 한 트랜잭션으로. 따로 커밋하면 advance 후 죽었을 때 그 스텝의
  // 발송이 영영 빠지고(재시도는 CAS 에 막힌다), 큐잉이 먼저면 중복 발송이 된다.
  await db.transaction(async (tx) => {
    // 원자적 advance: 여전히 이 스텝일 때만 (동시 처리기 중복 차단)
    const claimed = await tx
      .update(journeyRuns)
      .set({ currentStep: plan.pc, status: done ? "completed" : "active", nextRunAt: plan.at })
      .where(and(eq(journeyRuns.id, runId), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)))
      .returning({ id: journeyRuns.id });
    if (claimed.length === 0 || !plan.send) return; // 다른 처리기가 이미 진행 / 보낼 것 없음

    const project = (
      await tx
        // 방해금지는 프로젝트 시간대로 판정한다 — 빠지면 UTC 로 계산돼 KST 프로젝트가 한밤중에 보낸다
        .select({ id: projects.id, quietStartHour: projects.quietStartHour, quietEndHour: projects.quietEndHour, timezone: projects.timezone })
        .from(projects)
        .where(eq(projects.id, run.projectId))
        .limit(1)
    )[0];
    if (!user || !project) return;

    // 콘솔·SDK 발송과 같은 검증(빈 제목·FCM 크기)과 방해금지 시간대를 거친다
    const ready = finalizeMessage({ type: "single", target: user.externalId, title: plan.send.title, body: plan.send.body });
    if ("error" in ready) {
      console.warn(`[journey] run ${runId} step ${run.currentStep} skipped: ${ready.error}`);
      return;
    }
    // 이 발송을 만든 스텝을 로그에 적는다 — 스텝별 퍼널(발송·클릭·전환)의 유일한 귀속 경로다.
    // PC 가 아니라 `instr.path` 를 적는 이유: 운영자가 스텝을 고치면 PC 는 다른 명령으로
    // 밀리지만 경로는 그 자리를 그대로 가리킨다.
    await enqueuePush(project, ready.message, {
      db: tx,
      sentBy: "journey",
      ...(instr ? { journey: { id: journey.id, stepPath: instr.path } } : {}),
    });
  });
}

/** 도래한 저니 실행 일괄 진행 (worker/cron). */
/** 처리하다 예외가 난 실행을 다시 집기까지 미루는 시간 — 같은 실행이 매 회차 맨 앞을 차지하지 않게 */
const FAILED_RUN_BACKOFF_MS = 5 * 60_000;

export async function drainJourneys(projectId: string, limit = 100): Promise<{ processed: number; failed: number }> {
  const db = getDb();
  const now = new Date();
  const due = await db
    .select({ id: journeyRuns.id, currentStep: journeyRuns.currentStep })
    .from(journeyRuns)
    .where(and(eq(journeyRuns.projectId, projectId), eq(journeyRuns.status, "active"), lte(journeyRuns.nextRunAt, now)))
    .orderBy(asc(journeyRuns.nextRunAt))
    .limit(limit);
  // 한 건이 던져도 나머지는 돈다 — 전에는 첫 예외에서 회차 전체가 멈췄고, 같은 행이 계속
  // 실패하면 그 프로젝트의 저니가 통째로 막혔다. 실패한 실행은 조금 뒤로 미룬다.
  let failed = 0;
  for (const run of due) {
    try {
      await processJourneyRun(run.id);
    } catch (e) {
      failed++;
      log.error("journey.run_failed", { projectId, runId: run.id, step: run.currentStep, error: errorMessage(e) });
      await db
        .update(journeyRuns)
        .set({ nextRunAt: new Date(Date.now() + FAILED_RUN_BACKOFF_MS) })
        .where(and(eq(journeyRuns.id, run.id), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)));
    }
  }
  return { processed: due.length - failed, failed };
}

/**
 * 스텝별 인원 — 지금 그 스텝에 **머물러 있는** 실행 수.
 *
 * 누적 통과 인원이 아니다. 실행이 남기는 건 PC 하나뿐이라 지나간 자리는 복원할 수 없다.
 * 대신 **발송이 일어난 스텝**은 `push_logs.step_path` 로 되짚을 수 있다 — `stepFunnel` 참조.
 */
export function stepCounts(program: Program, runs: { currentStep: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const instr of program.instructions) out[instr.path] = 0;
  for (const r of runs) {
    const path = program.instructions[r.currentStep]?.path;
    if (path !== undefined) out[path] += 1;
  }
  return out;
}

/** 스텝 한 칸의 퍼널 — 지금 머문 실행 수 + 그 스텝이 낸 발송·클릭·전환 누적. */
export type StepFunnelRow = {
  path: string;
  kind: Instruction["kind"];
  /** 지금 이 스텝에 머물러 있는 실행 수 */
  waiting: number;
  /** 이 스텝이 낸 발송이 실제로 닿은 사람 수(FCM 접수 기준 누적) */
  sent: number;
  /** 유니크 클릭 수 — 발송 로그의 캐시된 분자를 그대로 더한다 */
  clicks: number;
  conversions: number;
};

/** 스텝별 집계의 원천 한 줄 — `push_logs` 를 step_path 로 묶은 결과. */
export type StepSendAgg = {
  stepPath: string | null;
  sent: number;
  clicks: number;
  conversions: number;
};

/**
 * 스텝별 퍼널을 만든다. 머문 수는 `journey_runs`, 발송·클릭·전환은 `push_logs.step_path` 에서 온다.
 *
 * 두 축의 출처가 다르다는 점이 중요하다 — 머문 수는 **지금**이고 발송 수는 **누적**이라,
 * 같은 줄에 두되 같은 분모로 읽지 않는다. 발송이 한 번도 없던 스텝은 0 이 아니라
 * "귀속 없음"이므로 sent 0 · clicks 0 으로 남기고 비율은 화면에서 판단한다.
 *
 * 발송 스텝이 아닌 칸(대기·분기·종료)도 줄을 남긴다. 빼 버리면 분기 아래 갈래가 화면에서
 * 사라져 어디서 사람이 끊겼는지 보이지 않는다.
 */
export function stepFunnel(
  program: Program,
  waiting: Record<string, number>,
  sends: StepSendAgg[]
): StepFunnelRow[] {
  const byPath = new Map<string, StepSendAgg>();
  for (const s of sends) {
    if (s.stepPath === null) continue;
    const prev = byPath.get(s.stepPath);
    // 같은 스텝이 여러 로그를 낸다(실행마다 1건) — DB 가 이미 묶어 줘도 방어적으로 더한다
    if (prev) byPath.set(s.stepPath, {
      stepPath: s.stepPath,
      sent: prev.sent + s.sent,
      clicks: prev.clicks + s.clicks,
      conversions: prev.conversions + s.conversions,
    });
    else byPath.set(s.stepPath, s);
  }
  return program.instructions.map((instr) => {
    const agg = byPath.get(instr.path);
    return {
      path: instr.path,
      kind: instr.kind,
      waiting: waiting[instr.path] ?? 0,
      sent: agg?.sent ?? 0,
      clicks: agg?.clicks ?? 0,
      conversions: agg?.conversions ?? 0,
    };
  });
}
