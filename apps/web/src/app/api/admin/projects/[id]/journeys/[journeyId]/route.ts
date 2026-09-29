import { and, eq, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { journeys } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { compileJourney, journeyStepsSchema, normalizeSteps, toStoredSteps, triggerEventsOf } from "@/lib/journey-triggers";
import { stepCounts, stepFunnel, type StepSendAgg } from "@/lib/journeys";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * 저니 단건 — 상세/수정 화면용.
 *
 * 모든 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 저니를
 * id 추측만으로 읽거나 고칠 수 있다.
 *
 * **이름은 바꿀 수 없다.** SDK 의 enroll 은 저니를 이름으로 찾는다
 * (`/api/v1/journeys/enroll` → `eq(journeys.name, ...)`). 콘솔에서 개명하면 이미
 * 배포된 앱의 `enroll({journey:"welcome"})` 이 조용히 404 가 된다 — 토픽 이름을
 * 막은 것과 같은 이유다. 이름을 바꾸려면 새로 만들고 앱을 함께 배포해야 한다.
 */
const updateSchema = z.object({
  steps: journeyStepsSchema,
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const row = (
    await db
      .select()
      .from(journeys)
      .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
      .limit(1)
  )[0];
  if (!row) return fail("Not found", 404);

  // 진행 중인 실행 수 — 스텝을 고치면 이 사람들에게 영향이 간다. 화면에서 경고하려면 필요하다.
  /**
   * 실패를 0 으로 삼키지 않는다 — 이 값의 유일한 쓰임이 삭제 경고라서, 0 으로 보이면
   * "진행 중 실행 없음"으로 읽히고 경고 없이 실행 이력이 cascade 삭제된다.
   */
  const runs = await db.execute(
    raw`select count(*) filter (where status = 'active')::int as active,
               count(*) filter (where status = 'exited')::int as exited,
               count(*)::int as total
          from journey_runs where journey_id = ${journeyId}`
  );
  const c = (runs as unknown as { active: number; exited: number; total: number }[])[0] ?? {
    active: 0,
    exited: 0,
    total: 0,
  };

  /**
   * 스텝별 인원. 진행 중 실행의 프로그램 카운터를 세어 트리 경로로 되돌린다 —
   * 어느 갈래로 사람이 몰리는지 보이지 않으면 분기를 만들 이유가 없다.
   *
   * 집계는 DB 에서(그룹), 경로 변환은 여기서 한다. 실행 행을 전부 들고 오면 실행이 많은
   * 저니에서 상세 화면 한 번에 수만 행이 올라온다.
   */
  const grouped = (await db.execute(
    raw`select current_step, count(*)::int as n
          from journey_runs where journey_id = ${journeyId} and status = 'active'
         group by current_step`
  )) as unknown as { current_step: number; n: number }[];
  const program = compileJourney(normalizeSteps(row.steps));
  const counts = stepCounts(program, []); // 모든 스텝을 0 으로 깔고 (빈 갈래도 화면에 남아야 한다)
  for (const g of grouped) {
    const path = program.instructions[g.current_step]?.path;
    if (path !== undefined) counts[path] = g.n;
  }

  /**
   * 스텝별 발송·클릭·전환 — `push_logs.step_path` 로 묶는다.
   *
   * 클릭은 로그에 캐시된 유니크 클릭 수(`click_count`)를 그대로 쓰고, 전환만 조인한다.
   * `push_clicks` 까지 조인하면 스텝 하나가 수천 로그를 내는 저니에서 상세 화면 한 번이
   * 클릭 테이블 전체를 훑는다 — 캐시는 이미 유니크 기준이라 같은 수다.
   *
   * 발송 수는 `success_count`(FCM 접수)가 아니라 `total_count`(그 스텝이 대상으로 잡은 기기)다.
   * 둘 다 기기 단위라 클릭 수와 분모가 맞고, Firebase 자격이 없는 프로젝트(log-only)에서도
   * 0 으로 주저앉지 않는다 — 접수 수를 쓰면 저니가 돌고 있는데 퍼널이 전부 0 으로 보인다.
   */
  const sends = (await db.execute(
    raw`select l.step_path as step_path,
               coalesce(sum(l.total_count), 0)::int as sent,
               coalesce(sum(l.click_count), 0)::int as clicks,
               coalesce(sum(v.n), 0)::int as conversions
          from push_logs l
          -- 전환은 로그별로 먼저 센다. 그대로 조인하면 로그 한 행이 전환 행 수만큼 반복돼
          -- sent·clicks 합계가 부풀려진다. 대조군 전환은 푸시가 만든 전환이 아니므로 뺀다.
          left join (
            select log_id, count(*) as n from push_conversions
             where project_id = ${id} and holdout = false and exposure = false
             group by log_id
          ) v on v.log_id = l.id
         where l.project_id = ${id} and l.journey_id = ${journeyId} and l.step_path is not null
         group by l.step_path`
  )) as unknown as { step_path: string; sent: number; clicks: number; conversions: number }[];
  const agg: StepSendAgg[] = sends.map((s) => ({
    stepPath: s.step_path,
    sent: s.sent,
    clicks: s.clicks,
    conversions: s.conversions,
  }));

  // total 도 함께 준다 — 삭제는 완료된 실행 이력까지 cascade 로 지운다
  return ok({
    journey: row,
    activeRuns: c.active,
    exitedRuns: c.exited,
    totalRuns: c.total,
    stepCounts: counts,
    stepFunnel: stepFunnel(program, counts, agg),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const db = getDb();
  const rows = await db
    .update(journeys)
    .set({ steps: toStoredSteps(parsed.data.steps), triggerEvents: triggerEventsOf(parsed.data.steps) })
    .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
    .returning();
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ journey: rows[0] });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  // journey_runs 는 FK cascade 로 함께 지워진다 — 진행 중이던 유저의 실행도 끝난다.
  const rows = await db
    .delete(journeys)
    .where(and(eq(journeys.id, journeyId), eq(journeys.projectId, id)))
    .returning({ id: journeys.id });
  if (rows.length === 0) return fail("Not found", 404);
  return ok({ deleted: rows[0].id });
}
