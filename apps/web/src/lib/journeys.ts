import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, pushLogs, pushUsers } from "@/db/schema";

/** 저니 실행 1건을 한 스텝 진행 (send → 큐 발송 생성, wait → 지연 예약) */
export async function processJourneyRun(runId: string): Promise<void> {
  const db = getDb();
  const run = (await db.select().from(journeyRuns).where(eq(journeyRuns.id, runId)).limit(1))[0];
  if (!run || run.status !== "active") return;

  const journey = (await db.select().from(journeys).where(eq(journeys.id, run.journeyId)).limit(1))[0];
  const step = journey?.steps[run.currentStep];
  if (!journey || !step) {
    await db.update(journeyRuns).set({ status: "completed" }).where(eq(journeyRuns.id, runId));
    return;
  }

  const nextStep = run.currentStep + 1;
  const done = nextStep >= journey.steps.length;

  if (step.type === "send") {
    const user = (await db.select({ externalId: pushUsers.externalId }).from(pushUsers).where(eq(pushUsers.id, run.userId)).limit(1))[0];
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
    await db.update(journeyRuns).set({ currentStep: nextStep, status: done ? "completed" : "active", nextRunAt: new Date() }).where(eq(journeyRuns.id, runId));
  } else {
    // wait
    const next = new Date(Date.now() + (step.hours ?? 0) * 3_600_000);
    await db.update(journeyRuns).set({ currentStep: nextStep, status: done ? "completed" : "active", nextRunAt: next }).where(eq(journeyRuns.id, runId));
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
