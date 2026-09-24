import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, journeys, journeyRuns, pushClicks, pushConversions, pushLogs, pushUsers } from "@/db/schema";
import type { DbOrTx } from "@/lib/messages";
import {
  compileJourney,
  entryEventOf,
  branchDecision,
  exitedBy,
  planStep,
  pathOf,
  normalizeSteps,
  journeyStepsSchema,
  type Program,
  type JourneyStep,
  type PlanContext,
  type StepPlan,
  type LastSend,
} from "@/lib/journey-steps";

export * from "@/lib/journey-steps";

// ─── DB: 진입 · 종료 ─────────────────────────────────────────────────────────

/**
 * 이벤트 한 건을 저니에 알린다 — 진입 트리거 등록 + 종료 조건 반영.
 *
 * 전환 엔드포인트(`/api/v1/events`)에서 신원 확인이 끝난 자리에 한 줄로 끼우면 된다.
 * 그 파일은 다른 소유라 여기서는 함수만 내보낸다(넣는 위치는 보고서에).
 *
 * `push_conversions` 를 직접 보지 않고 훅을 두는 이유: 전환 기록은 **클릭에 귀속될 때만**
 * 남는다(최근 24시간 안에 누른 발송이 없으면 202 로 버려진다). 귀속 안 된 전환도 "한 일"은
 * 한 것이므로 종료 조건은 그것까지 봐야 한다.
 */
export async function onJourneyEvent(
  db: DbOrTx,
  projectId: string,
  name: string,
  who: { deviceId?: string | null; externalId?: string | null }
): Promise<{ userId: string | null; enrolled: string[]; exited: string[] }> {
  const userId = await resolveUserId(db, projectId, who);
  if (!userId) return { userId: null, enrolled: [], exited: [] };

  const rows = await db
    .select({ id: journeys.id, steps: journeys.steps })
    .from(journeys)
    .where(eq(journeys.projectId, projectId));

  const enrolled: string[] = [];
  const exited: string[] = [];
  for (const j of rows) {
    const program = compileJourney(normalizeSteps(j.steps));
    if (program.entryEvent === name) {
      // 멱등: (journey, user) 유니크가 두 번째 등록을 조용히 삼킨다
      const run = (
        await db
          .insert(journeyRuns)
          .values({ journeyId: j.id, projectId, userId, currentStep: 0, status: "active", nextRunAt: new Date() })
          .onConflictDoNothing({ target: [journeyRuns.journeyId, journeyRuns.userId] })
          .returning({ id: journeyRuns.id })
      )[0];
      if (run) enrolled.push(run.id);
    }
    if (program.exitEvents.includes(name)) {
      const stopped = await db
        .update(journeyRuns)
        .set({ status: "exited" })
        .where(and(eq(journeyRuns.journeyId, j.id), eq(journeyRuns.userId, userId), eq(journeyRuns.status, "active")))
        .returning({ id: journeyRuns.id });
      for (const r of stopped) exited.push(r.id);
    }
  }
  return { userId, enrolled, exited };
}

async function resolveUserId(
  db: DbOrTx,
  projectId: string,
  who: { deviceId?: string | null; externalId?: string | null }
): Promise<string | null> {
  if (who.externalId) {
    const u = (
      await db
        .select({ id: pushUsers.id })
        .from(pushUsers)
        .where(and(eq(pushUsers.projectId, projectId), eq(pushUsers.externalId, who.externalId)))
        .limit(1)
    )[0];
    return u?.id ?? null;
  }
  if (who.deviceId) {
    const d = (
      await db
        .select({ userId: devices.userId })
        .from(devices)
        .where(and(eq(devices.projectId, projectId), eq(devices.id, who.deviceId)))
        .limit(1)
    )[0];
    return d?.userId ?? null;
  }
  return null;
}

/** 등록 이후 이 사람에게 기록된 전환 이름들 — 종료 조건 판정의 보조 경로 */
export async function conversionsSince(
  db: DbOrTx,
  projectId: string,
  userId: string,
  names: string[],
  since: Date
): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await db
    .select({ name: pushConversions.name })
    .from(pushConversions)
    .where(
      and(
        eq(pushConversions.projectId, projectId),
        eq(pushConversions.userId, userId),
        inArray(pushConversions.name, names),
        gte(pushConversions.createdAt, since)
      )
    );
  return new Set(rows.map((r) => r.name));
}

/**
 * 분기가 보는 직전 발송 — 이 실행이 시작된 뒤 이 사람에게 나간 마지막 저니 발송.
 *
 * `created_at >= since` 로 훑는 범위를 묶는다. 없으면 저니 발송이 한 번도 없는 사람마다
 * 프로젝트의 발송 로그 전체를 역순으로 끝까지 훑는다(`push_logs_project_idx` 가
 * (project_id, created_at) 이라 범위가 없으면 멈출 자리가 없다).
 *
 * 한계: 한 사람이 저니 둘에 동시에 들어가 있으면 다른 저니의 발송을 집을 수 있다.
 * `journey_runs.last_send_log_id` 컬럼이 생기면 정확해진다.
 */
export async function lastJourneySend(
  db: DbOrTx,
  projectId: string,
  userId: string,
  externalId: string,
  since: Date
): Promise<LastSend | null> {
  const log = (
    await db
      .select({ id: pushLogs.id, createdAt: pushLogs.createdAt })
      .from(pushLogs)
      .where(
        and(
          eq(pushLogs.projectId, projectId),
          eq(pushLogs.sentBy, "journey"),
          eq(pushLogs.type, "single"),
          eq(pushLogs.target, externalId),
          gte(pushLogs.createdAt, since)
        )
      )
      .orderBy(desc(pushLogs.createdAt))
      .limit(1)
  )[0];
  if (!log) return null;

  const click = (
    await db
      .select({ clickedAt: pushClicks.clickedAt })
      .from(pushClicks)
      .where(and(eq(pushClicks.logId, log.id), eq(pushClicks.userId, userId)))
      .orderBy(desc(pushClicks.clickedAt))
      .limit(1)
  )[0];
  return { sentAt: log.createdAt, clickedAt: click?.clickedAt ?? null };
}

/**
 * 트리를 `journeys.steps` 컬럼 타입으로 넘긴다.
 *
 * 컬럼의 `$type` 은 아직 분기 이전의 평탄 목록(`{type:'send'|'wait'}`)이다. jsonb 라
 * 저장·조회는 그대로 되지만 타입이 좁아 삽입에서 막힌다. schema.ts 는 다른 소유라
 * 여기 한 곳에서만 넓힌다 — 컬럼 `$type` 이 트리로 바뀌면 이 함수만 지우면 된다.
 */
export function toStoredSteps(steps: JourneyStep[]): typeof journeys.$inferInsert["steps"] {
  return steps as unknown as typeof journeys.$inferInsert["steps"];
}

/** 이벤트 이름으로 진입 트리거가 걸린 저니가 있는지 (엔드포인트 응답용) */
export async function journeysForEvent(projectId: string, name: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: journeys.id, steps: journeys.steps }).from(journeys).where(eq(journeys.projectId, projectId));
  return rows.filter((j) => entryEventOf(normalizeSteps(j.steps)) === name).map((j) => j.id);
}
