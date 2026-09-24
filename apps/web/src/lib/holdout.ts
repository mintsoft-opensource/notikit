/**
 * 홀드아웃(대조군) — 발송에서 X% 를 **아무것도 보내지 않고** 빼 두고, 그 사람들의 전환과 비교한다.
 *
 * A/B 는 변형끼리만 비교하므로 "푸시가 없었을 때보다 나은가"를 끝내 말하지 못한다. 대조군이 있어야
 * 리프트가 증명된다.
 *
 * 버킷은 **사람 단위로 고정**한다. 발송마다 다시 뽑으면(로그 id 를 해시에 섞으면) 매 캠페인의
 * 대조군이 달라져, 같은 사람이 어떤 캠페인에서는 받고 어떤 캠페인에서는 안 받는다 — 그러면
 * 측정하는 것이 "푸시의 효과"가 아니라 "그날 누가 뽑혔는가"가 되어 숫자가 의미를 잃는다.
 * 사람을 모르는 익명 기기는 토큰으로 고정한다(기기 단위로는 흔들리지 않는다).
 *
 * 해시는 `abBucket` 을 그대로 쓰되 키에 접두사를 붙인다 — A/B 표본 버킷(토큰 그대로)과 상관이
 * 생기면 "표본에 든 사람이 늘 홀드아웃"처럼 두 축이 붙어 버린다.
 */
import { and, eq, gt, desc } from "drizzle-orm";
import { pushHoldouts, type PushLog } from "@/db/schema";
import { abBucket } from "@/lib/ab-test";
import type { Db } from "@/lib/audience-count";

/** 홀드아웃 비율(%)의 허용 범위 — 절반을 빼면 캠페인이 아니라 실험이다 */
export const HOLDOUT_MIN = 1;
export const HOLDOUT_MAX = 50;

const HOLDOUT_SALT = "holdout:";

export type HoldoutRow = { token: string; userId: string | null };

/**
 * 버킷 키 — 사람이 있으면 사람, 없으면 기기. 사람이 기기를 바꿔도 같은 쪽에 남는다(순수 함수).
 */
export function holdoutKey(row: HoldoutRow): string {
  return row.userId ? `${HOLDOUT_SALT}u:${row.userId}` : `${HOLDOUT_SALT}d:${row.token}`;
}

/** 이 주체가 대조군인가(순수 함수). 같은 사람은 언제 계산해도 같은 답이 나온다. */
export function inHoldout(row: HoldoutRow, percent: number | null | undefined): boolean {
  if (!percent) return false;
  return abBucket(holdoutKey(row)) < percent;
}

/**
 * 페이지를 "보낼 것"과 "빼 둘 것"으로 가른다(순수 함수).
 * 빈도 상한 예약·속도 제한 예산보다 **먼저** 불러야 대조군이 슬롯을 태우지 않는다.
 */
export function splitHoldout<T extends HoldoutRow>(rows: T[], percent: number | null | undefined): { send: T[]; held: T[] } {
  if (!percent) return { send: rows, held: [] };
  const send: T[] = [];
  const held: T[] = [];
  for (const row of rows) (inHoldout(row, percent) ? held : send).push(row);
  return { send, held };
}

/**
 * 대조군 명단을 남긴다. 남기지 않으면 나중에 누가 대조군이었는지 복원할 방법이 없다 —
 * 기기 집합은 계속 변하고 해시만으로는 "그때 대상이었는가"를 되살릴 수 없다.
 * (log, device) 기본키라 재클레임이 같은 페이지를 다시 훑어도 한 행이다.
 */
export async function recordHoldout(
  db: Db,
  log: Pick<PushLog, "id" | "projectId">,
  held: Array<{ id: string; userId: string | null }>
): Promise<void> {
  if (held.length === 0) return;
  await db
    .insert(pushHoldouts)
    .values(held.map((d) => ({ projectId: log.projectId, logId: log.id, deviceId: d.id, userId: d.userId })))
    .onConflictDoNothing();
}

export type HoldoutSubject = { deviceId: string | null; userId: string | null };

/**
 * 이 주체가 최근에 들어간 홀드아웃 발송. 전환 보고가 **클릭이 없을 때** 쓴다 —
 * 대조군은 정의상 푸시를 받지 않았으므로 클릭이 없고, 클릭만 보는 귀속으로는 영원히 0건이다.
 * 귀속 창(클릭 귀속과 같은 24시간) 안의 가장 최근 것 하나만 본다.
 */
export async function findHoldoutLog(db: Db, projectId: string, subject: HoldoutSubject, since: Date): Promise<string | null> {
  const scope = subject.userId
    ? eq(pushHoldouts.userId, subject.userId)
    : subject.deviceId
      ? eq(pushHoldouts.deviceId, subject.deviceId)
      : null;
  if (!scope) return null;
  const row = (
    await db
      .select({ logId: pushHoldouts.logId })
      .from(pushHoldouts)
      .where(and(eq(pushHoldouts.projectId, projectId), scope, gt(pushHoldouts.createdAt, since)))
      .orderBy(desc(pushHoldouts.createdAt))
      .limit(1)
  )[0];
  return row?.logId ?? null;
}

/** 리프트(%) — 대조군 전환율 대비. 대조군 전환율이 0 이면 비율을 낼 수 없어 null(순수 함수). */
export function conversionLift(sent: { converted: number; total: number }, held: { converted: number; total: number }): number | null {
  if (sent.total === 0 || held.total === 0) return null;
  const heldRate = held.converted / held.total;
  if (heldRate === 0) return null;
  return (sent.converted / sent.total - heldRate) / heldRate;
}
