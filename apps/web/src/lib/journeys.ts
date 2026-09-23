import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys, journeyRuns, projects, pushUsers } from "@/db/schema";
import { enqueuePush, finalizeMessage } from "@/lib/messages";

/**
 * 저니 실행 1건을 한 스텝 진행. **원자적 CAS**(currentStep 조건 advance)로 동시 처리 중복 방지:
 * advance 가 성공(1행)한 처리기만 같은 트랜잭션 안에서 발송을 큐잉한다.
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

  // advance 와 발송 큐잉을 한 트랜잭션으로. 따로 커밋하면 advance 후 죽었을 때 그 스텝의
  // 발송이 영영 빠지고(재시도는 CAS 에 막힌다), 큐잉이 먼저면 중복 발송이 된다.
  await db.transaction(async (tx) => {
    // 원자적 advance: 여전히 이 스텝일 때만 (동시 처리기 중복 차단)
    const claimed = await tx
      .update(journeyRuns)
      .set({ currentStep: nextStep, status: done ? "completed" : "active", nextRunAt })
      .where(and(eq(journeyRuns.id, runId), eq(journeyRuns.status, "active"), eq(journeyRuns.currentStep, run.currentStep)))
      .returning({ id: journeyRuns.id });
    if (claimed.length === 0 || step.type !== "send") return; // 다른 처리기가 이미 진행 / 보낼 것 없음

    const user = (
      await tx.select({ externalId: pushUsers.externalId }).from(pushUsers)
        .where(and(eq(pushUsers.id, run.userId), eq(pushUsers.projectId, run.projectId))).limit(1)
    )[0];
    const project = (
      await tx
        .select({ id: projects.id, quietStartHour: projects.quietStartHour, quietEndHour: projects.quietEndHour })
        .from(projects)
        .where(eq(projects.id, run.projectId))
        .limit(1)
    )[0];
    if (!user || !project) return;

    // 콘솔·SDK 발송과 같은 검증(빈 제목·FCM 크기)과 방해금지 시간대를 거친다
    const ready = finalizeMessage({ type: "single", target: user.externalId, title: step.title, body: step.body });
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
