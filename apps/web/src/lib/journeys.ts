import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, projects, pushUsers } from "@/db/schema";
import { enqueuePush, finalizeMessage } from "@/lib/messages";
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
      ? await lastJourneySend(db, run.projectId, run.userId, user.externalId, enrolledAt)
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
        .select({ id: projects.id, quietStartHour: projects.quietStartHour, quietEndHour: projects.quietEndHour })
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
    await enqueuePush(project, ready.message, { db: tx, sentBy: "journey" });
  });
}

/** 도래한 저니 실행 일괄 진행 (worker/cron). */
export async function drainJourneys(projectId: string, limit = 100): Promise<{ processed: number }> {
  const db = getDb();
  const now = new Date();
  const due = await db
    .select({ id: journeyRuns.id })
    .from(journeyRuns)
    .where(and(eq(journeyRuns.projectId, projectId), eq(journeyRuns.status, "active"), lte(journeyRuns.nextRunAt, now)))
    .limit(limit);
  for (const { id } of due) await processJourneyRun(id);
  return { processed: due.length };
}

/**
 * 스텝별 인원 — 지금 그 스텝에 **머물러 있는** 실행 수.
 *
 * 누적 통과 인원이 아니다. 실행이 남기는 건 PC 하나뿐이라 지나간 자리는 복원할 수 없다.
 * (`journey_step_stats` 테이블이 생기면 누적으로 바꾼다 — 보고서 참조.)
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
