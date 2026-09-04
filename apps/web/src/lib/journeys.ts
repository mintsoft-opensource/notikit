import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, pushLogs, pushUsers } from "@/db/schema";

/**
 * 저니 실행 1건을 한 스텝 진행. **원자적 CAS**(currentStep 조건 advance)로 동시 처리 중복 방지:
 * advance 가 성공(1행)한 처리기만 side effect(발송 큐잉)를 수행.
 */
export async function processJourneyRun(runId: string): Promise<void> {
  const db = getDb();
  const run = (await db.select().from(journeyRuns).where(eq(journeyRuns.id, runId)).limit(1))[0];
  if (!run || run.status !== "active") return;

  // 저니는 같은 프로젝트 것만 (테넌트 일관성)
  const journey = (
    await db.select().from(journeys).where(and(eq(journeys.id, run.journeyId), eq(journeys.projectId, run.projectId))).limit(1)
  )[0];
  const step = journey?.steps[run.currentStep];
  if (!journey || !step) {
    await db.update(journeyRuns).set({ status: "completed" }).where(eq(journeyRuns.id, runId));
    return;
  }

  const nextStep = run.currentStep + 1;
  const done = nextStep >= journey.steps.length;
  const nextRunAt = step.type === "wait" ? new Date(Date.now() + (step.hours ?? 0) * 3_600_000) : new Date();

  // 원자적 advance: 여전히 이 스텝일 때만 (동시 처리기 중복 차단)
  const claimed = await db
    .update(journeyRuns)
    .set({ currentStep: nextStep, status: done ? "completed" : "active", nextRunAt })
    .where(and(eq(journeyRuns.id, runId), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)))
    .returning({ id: journeyRuns.id });
  if (claimed.length === 0) return; // 다른 처리기가 이미 진행

  // claim 성공 후에만 side effect
  if (step.type === "send") {
    const user = (
      await db.select({ externalId: pushUsers.externalId }).from(pushUsers)
        .where(and(eq(pushUsers.id, run.userId), eq(pushUsers.projectId, run.projectId))).limit(1)
    )[0];
    if (user) {
      await db.insert(pushLogs).values({
        projectId: run.projectId,
        type: "single",
        target: user.externalId,
        title: step.title ?? "",
        body: step.body ?? "",
        status: "queued",
      });
    }
  }
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
