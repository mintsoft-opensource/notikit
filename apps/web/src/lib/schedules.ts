/**
 * 반복 예약(push_schedules) — daily / weekly(요일) / monthly(일) + 시:분.
 *
 * cron 문자열을 쓰지 않는다: 운영자가 쓰는 반복은 이 셋뿐이고, cron 은 화면에서 읽어 주기도
 * 검증하기도 어렵다. 시각은 언제나 **프로젝트 타임존의 벽시계**로 해석한다 —
 * "매일 09:00" 은 서머타임이 바뀌어도 현지 09:00 이어야 한다.
 *
 * 발송은 `enqueuePush` 로 `push_logs` 1행을 만들 뿐이다. 방해금지 시간대·빈도 상한·
 * 재시도는 기존 발송 경로가 그대로 처리한다.
 */
import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { projects, pushSchedules, type PushSchedule } from "@/db/schema";
import { enqueuePush, messageSchema, prepareMessage, targetError, type EnqueueProject } from "@/lib/messages";
import { dateFromWallClock, wallClockIn, type Wall } from "@/lib/quiet-hours";

export type ScheduleKind = "daily" | "weekly" | "monthly";

/** 반복 규칙. weekday 는 0(일)~6(토), dayOfMonth 는 1~28. */
export type Recurrence = {
  kind: ScheduleKind;
  weekday?: number | null;
  dayOfMonth?: number | null;
  hour: number;
  minute: number;
};

/* ─────────────────────────── 회차 계산 ───────────────────────────
 * 벽시계 변환은 quiet-hours.ts 것을 그대로 쓴다(wallClockIn·dateFromWallClock).
 * 예전에는 같은 로직을 여기에 한 벌 더 두었는데, 한쪽만 고치면 방해금지와 예약이
 * 서머타임 경계에서 서로 다른 시각을 가리킨다 — 한 곳에만 둔다.
 */

/** 월 1회 + 윤년 여유. 이 안에 한 번도 맞지 않는 규칙은 없다. */
const SCAN_DAYS = 400;

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 달력 날짜를 n일 이동 (시:분은 유지). Date.UTC 가 월말 넘침을 정규화한다. */
function addDays(w: Wall, n: number): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: w.hour, minute: w.minute };
}

function weekdayOf(w: Wall): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

function matchesDay(rec: Recurrence, w: Wall): boolean {
  if (rec.kind === "daily") return true;
  if (rec.kind === "weekly") return weekdayOf(w) === rec.weekday;
  // 입력은 1~28 로 막지만 계산은 말일로 당겨 둔다 — 29~31 이 저장돼 있어도
  // "그 달에는 안 보냄"으로 조용히 사라지지 않게.
  const day = Math.min(rec.dayOfMonth ?? 1, lastDayOfMonth(w.year, w.month));
  return w.day === day;
}

/**
 * 그 날짜의 발송 시각. 서머타임 시작으로 **사라진** 벽시계(예: 02:30)면 전환 직후로 민다 —
 * 오지 않는 시각으로 예약하면 한 시간 일찍(=전날 오프셋으로) 나간다.
 */
function instantAt(timeZone: string | null | undefined, day: Wall, hour: number, minute: number): Date {
  const want: Wall = { ...day, hour, minute };
  const at = dateFromWallClock(timeZone, want);
  const got = wallClockIn(timeZone, at);
  if (got.hour === hour && got.minute === minute) return at;
  return dateFromWallClock(timeZone, { ...want, hour: hour + 1 });
}

/** `after` **보다 뒤**의 첫 회차. 같은 시각은 이미 지난 것으로 본다. */
export function nextOccurrence(rec: Recurrence, after: Date, timeZone?: string | null): Date {
  const base = wallClockIn(timeZone, after);
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const day = addDays(base, i);
    if (!matchesDay(rec, day)) continue;
    const at = instantAt(timeZone, day, rec.hour, rec.minute);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error(`nextOccurrence: no occurrence within ${SCAN_DAYS} days`);
}

/** `at` 시점(포함)에서 가장 가까운 지난 회차. 없으면 null. */
export function previousOccurrence(rec: Recurrence, at: Date, timeZone?: string | null): Date | null {
  const base = wallClockIn(timeZone, at);
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const day = addDays(base, -i);
    if (!matchesDay(rec, day)) continue;
    const inst = instantAt(timeZone, day, rec.hour, rec.minute);
    if (inst.getTime() <= at.getTime()) return inst;
  }
  return null;
}

/** 밀린 회차 수를 세는 상한 — 몇 년치 다운타임에서 tick 이 갇히지 않게. */
const MAX_MISSED_COUNT = 1000;

function countOccurrences(rec: Recurrence, from: Date, to: Date, timeZone?: string | null): number {
  let n = 0;
  let cursor = new Date(from.getTime() - 1); // from 자신을 포함시킨다
  while (n < MAX_MISSED_COUNT) {
    const o = nextOccurrence(rec, cursor, timeZone);
    if (o.getTime() > to.getTime()) break;
    n += 1;
    cursor = o;
  }
  return n;
}

/**
 * 도래한 회차를 몰아 보내지 않기 위한 유예. 워커가 멈췄다 살아나면 밀린 회차가 여러 개
 * 쌓여 있는데, 그걸 전부 보내면 유저에게 같은 푸시가 연달아 떨어진다.
 * **가장 최근 회차 하나만**, 그것도 이 유예 안일 때만 보낸다.
 */
export const CATCH_UP_GRACE_MS = 15 * 60_000;

export type ScheduleState = Recurrence & {
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
};

export type SchedulePlan = {
  /** 보낼 회차. null 이면 이번 tick 에는 보내지 않는다. */
  fire: Date | null;
  /** 건너뛴(=몰아 보내지 않은) 밀린 회차 수 */
  skipped: number;
  /** 저장할 다음 도래 시각 */
  nextRunAt: Date;
};

/**
 * 이번 tick 에 무엇을 할지 결정한다. 순수 함수 — DB·시계에 의존하지 않는다.
 *
 * 규칙:
 * 1. 아직 도래 전이면 아무것도 하지 않는다.
 * 2. 도래했으면 **가장 최근 회차 하나만** 후보로 본다. 그 사이의 밀린 회차는 버린다.
 * 3. 후보가 유예(15분)를 넘겼으면 그것도 버린다 — 09시 푸시를 18시에 보내는 건 안 보내느니만 못하다.
 * 4. 이미 보낸 회차면(last_run_at) 보내지 않는다. 같은 tick 이 두 번 돌아도 안전하다.
 */
export function planScheduleTick(s: ScheduleState, now: Date, timeZone?: string | null): SchedulePlan {
  if (!s.enabled || s.nextRunAt === null) {
    return { fire: null, skipped: 0, nextRunAt: nextOccurrence(s, now, timeZone) };
  }
  if (s.nextRunAt.getTime() > now.getTime()) {
    return { fire: null, skipped: 0, nextRunAt: s.nextRunAt };
  }

  const last = previousOccurrence(s, now, timeZone);
  const alreadySent = last !== null && !!s.lastRunAt && last.getTime() <= s.lastRunAt.getTime();
  const fresh = last !== null && !alreadySent && now.getTime() - last.getTime() <= CATCH_UP_GRACE_MS;
  const due = countOccurrences(s, s.nextRunAt, now, timeZone);

  return {
    fire: fresh ? last : null,
    // 이미 보낸 회차는 "건너뛴" 것이 아니다 — 세면 tick 마다 없는 유실을 경고하게 된다
    skipped: Math.max(0, due - (fresh || alreadySent ? 1 : 0)),
    nextRunAt: nextOccurrence(s, now, timeZone),
  };
}

/**
 * 회차별 멱등 키. 워커 두 대가 같은 순간에 같은 예약을 집어도 `push_logs` 는 1행만 생긴다 —
 * `enqueuePush` 가 (project_id, idempotency_key) 부분 유니크 인덱스로 잡는다.
 */
export function occurrenceKey(scheduleId: string, occurrence: Date): string {
  return `${scheduleId}:${occurrence.toISOString()}`;
}

/* ─────────────────────────── 입력 검증 ─────────────────────────── */

/**
 * 예약이 담는 메시지 본문. 발송 스키마에서 `scheduled_at`(반복이 시각을 정한다)과
 * `test`(테스트 발송은 반복시킬 일이 없다)만 뺀다.
 */
export const scheduleMessageSchema = messageSchema.omit({ scheduled_at: true, test: true });

export const scheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["daily", "weekly", "monthly"]),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    // 1~28 로 제한한다. 29~31 은 달마다 "있는 날/없는 날"이 갈려 운영자가 기대한 날짜와
    // 실제 발송일이 어긋난다 — 월말 발송이 필요하면 28일로 잡는 편이 예측 가능하다.
    day_of_month: z.number().int().min(1).max(28).nullable().optional(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    message: scheduleMessageSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "weekly" && (v.weekday ?? null) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekday"], message: "weekday is required for kind=weekly" });
    }
    if (v.kind === "monthly" && (v.day_of_month ?? null) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["day_of_month"],
        message: "day_of_month is required for kind=monthly",
      });
    }
    const err = targetError(v.message);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["message"], message: err });
  });

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

function toRecurrence(v: Pick<ScheduleInput, "kind" | "weekday" | "day_of_month" | "hour" | "minute">): Recurrence {
  return {
    kind: v.kind,
    // 쓰지 않는 칸은 비운다 — weekly 로 바꿨다 monthly 로 되돌린 예약에 옛 요일이 남지 않게
    weekday: v.kind === "weekly" ? (v.weekday ?? 0) : null,
    dayOfMonth: v.kind === "monthly" ? (v.day_of_month ?? 1) : null,
    hour: v.hour,
    minute: v.minute,
  };
}

/* ─────────────────────────── 저장소 ─────────────────────────── */

/** `kind` 는 DB 에서 text 라 좁혀 읽는다. 그 밖의 값이 들어 있으면 daily 로 본다(발송을 멈추지는 않는다). */
function rowKind(kind: string): ScheduleKind {
  return kind === "weekly" || kind === "monthly" ? kind : "daily";
}

export type ScheduleDto = {
  id: string;
  name: string;
  kind: ScheduleKind;
  weekday: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  message: unknown;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
};

function scheduleDto(r: PushSchedule): ScheduleDto {
  return {
    id: r.id,
    name: r.name,
    kind: rowKind(r.kind),
    weekday: r.weekday,
    dayOfMonth: r.dayOfMonth,
    hour: r.hour,
    minute: r.minute,
    message: r.message,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

function rowState(r: PushSchedule): ScheduleState {
  return {
    kind: rowKind(r.kind),
    weekday: r.weekday,
    dayOfMonth: r.dayOfMonth,
    hour: r.hour,
    minute: r.minute,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
  };
}

/** 예약 판정·발송에 필요한 프로젝트 값. 없으면 undefined(=프로젝트 없음). */
async function scheduleProject(projectId: string): Promise<(EnqueueProject & { timezone: string | null }) | undefined> {
  return (
    await getDb()
      .select({
        id: projects.id,
        quietStartHour: projects.quietStartHour,
        quietEndHour: projects.quietEndHour,
        timezone: projects.timezone,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
  )[0];
}

/** 단건 조회는 언제나 projectId 를 함께 건다 — id 추측만으로 남의 프로젝트 예약을 만지지 못하게. */
async function findRow(projectId: string, scheduleId: string): Promise<PushSchedule | undefined> {
  return (
    await getDb()
      .select()
      .from(pushSchedules)
      .where(and(eq(pushSchedules.id, scheduleId), eq(pushSchedules.projectId, projectId)))
      .limit(1)
  )[0];
}

export async function listSchedules(projectId: string): Promise<ScheduleDto[]> {
  const rows = await getDb()
    .select()
    .from(pushSchedules)
    .where(eq(pushSchedules.projectId, projectId))
    .orderBy(desc(pushSchedules.createdAt));
  return rows.map(scheduleDto);
}

export async function getSchedule(projectId: string, scheduleId: string): Promise<ScheduleDto | null> {
  const row = await findRow(projectId, scheduleId);
  return row ? scheduleDto(row) : null;
}

export async function createSchedule(projectId: string, input: ScheduleInput): Promise<ScheduleDto | null> {
  const project = await scheduleProject(projectId);
  if (!project) return null;
  const rec = toRecurrence(input);
  const enabled = input.enabled ?? true;
  const row = (
    await getDb()
      .insert(pushSchedules)
      .values({
        projectId,
        name: input.name,
        kind: input.kind,
        weekday: rec.weekday,
        dayOfMonth: rec.dayOfMonth,
        hour: input.hour,
        minute: input.minute,
        message: input.message,
        enabled,
        nextRunAt: enabled ? nextOccurrence(rec, new Date(), project.timezone) : null,
      })
      .returning()
  )[0];
  return row ? scheduleDto(row) : null;
}

/**
 * 전체 교체. 반복 규칙이 바뀌면 `next_run_at` 을 **지금 기준으로 다시 계산**한다 —
 * 옛 규칙으로 잡아 둔 도래 시각을 그대로 두면 바꾼 직후 엉뚱한 시각에 한 번 더 나간다.
 */
export async function updateSchedule(
  projectId: string,
  scheduleId: string,
  input: ScheduleInput
): Promise<ScheduleDto | null> {
  const project = await scheduleProject(projectId);
  if (!project) return null;
  const rec = toRecurrence(input);
  const enabled = input.enabled ?? true;
  const row = (
    await getDb()
      .update(pushSchedules)
      .set({
        name: input.name,
        kind: input.kind,
        weekday: rec.weekday,
        dayOfMonth: rec.dayOfMonth,
        hour: input.hour,
        minute: input.minute,
        message: input.message,
        enabled,
        nextRunAt: enabled ? nextOccurrence(rec, new Date(), project.timezone) : null,
      })
      .where(and(eq(pushSchedules.id, scheduleId), eq(pushSchedules.projectId, projectId)))
      .returning()
  )[0];
  return row ? scheduleDto(row) : null;
}

/**
 * 켜기/끄기. 다시 켤 때는 도래 시각을 지금 기준으로 다시 잡는다 —
 * 껐던 동안의 회차를 그대로 두면 켜자마자 밀린 발송이 한 번 나간다.
 */
export async function setScheduleEnabled(
  projectId: string,
  scheduleId: string,
  enabled: boolean
): Promise<ScheduleDto | null> {
  const row = await findRow(projectId, scheduleId);
  if (!row) return null;
  const project = await scheduleProject(projectId);
  const updated = (
    await getDb()
      .update(pushSchedules)
      .set({
        enabled,
        nextRunAt: enabled ? nextOccurrence(rowState(row), new Date(), project?.timezone) : null,
      })
      .where(and(eq(pushSchedules.id, scheduleId), eq(pushSchedules.projectId, projectId)))
      .returning()
  )[0];
  return updated ? scheduleDto(updated) : null;
}

export async function deleteSchedule(projectId: string, scheduleId: string): Promise<string | null> {
  const rows = await getDb()
    .delete(pushSchedules)
    .where(and(eq(pushSchedules.id, scheduleId), eq(pushSchedules.projectId, projectId)))
    .returning({ id: pushSchedules.id });
  return rows[0]?.id ?? null;
}

/* ─────────────────────────── 실행 ─────────────────────────── */

export type ScheduleRunResult = { checked: number; fired: number; skipped: number };

/** 한 tick 에 훑는 예약 수 상한 — 한 프로젝트가 tick 을 독점하지 않게. 남으면 다음 tick 이 잇는다. */
const RUN_LIMIT = 50;

/**
 * 도래한 예약을 처리한다(워커 tick).
 *
 * 여기서는 `push_logs` 1행을 만들 뿐이고 실제 fan-out 은 기존 큐 처리기가 한다 —
 * 덕분에 방해금지 시간대·빈도 상한·재시도·중복 억제가 자동으로 따라온다.
 */
export async function runDueSchedules(
  projectId: string,
  now = new Date(),
  limit = RUN_LIMIT
): Promise<ScheduleRunResult> {
  const project = await scheduleProject(projectId);
  if (!project) return { checked: 0, fired: 0, skipped: 0 };

  const db = getDb();
  const rows = await db
    .select()
    .from(pushSchedules)
    .where(
      and(
        eq(pushSchedules.projectId, projectId),
        eq(pushSchedules.enabled, true),
        isNotNull(pushSchedules.nextRunAt),
        lte(pushSchedules.nextRunAt, now)
      )
    )
    .orderBy(asc(pushSchedules.nextRunAt))
    .limit(limit);

  let fired = 0;
  let skipped = 0;
  for (const row of rows) {
    const plan = planScheduleTick(rowState(row), now, project.timezone);
    skipped += plan.skipped;
    if (plan.skipped > 0) {
      console.warn(`[schedule] ${row.id} skipped ${plan.skipped} missed occurrence(s) after downtime`);
    }
    if (plan.fire && (await fireSchedule(project, row, plan.fire))) fired += 1;
    // 발송이 실패(잘못된 본문 등)해도 next_run_at 은 전진시킨다 — 안 그러면 매 tick 마다 같은 실패를 반복한다
    await db
      .update(pushSchedules)
      .set({ nextRunAt: plan.nextRunAt, ...(plan.fire ? { lastRunAt: plan.fire } : {}) })
      .where(and(eq(pushSchedules.id, row.id), eq(pushSchedules.projectId, projectId)));
  }
  return { checked: rows.length, fired, skipped };
}

async function fireSchedule(project: EnqueueProject, row: PushSchedule, occurrence: Date): Promise<boolean> {
  const parsed = scheduleMessageSchema.safeParse(row.message);
  if (!parsed.success) {
    console.warn(`[schedule] ${row.id} has an unusable message: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return false;
  }
  const ready = await prepareMessage(project.id, parsed.data);
  if ("error" in ready) {
    console.warn(`[schedule] ${row.id} was not queued: ${ready.error}`);
    return false;
  }
  const res = await enqueuePush(project, ready.message, {
    sentBy: "schedule",
    idempotencyKey: occurrenceKey(row.id, occurrence),
  });
  // replay 면 다른 워커가 이미 이 회차를 넣었다는 뜻이다 — 중복이 아니라 정상 동작
  return !res.replay;
}
