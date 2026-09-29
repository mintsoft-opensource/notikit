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

export type HoldoutRow = { id: string; userId: string | null };

/**
 * 버킷 키 — 사람이 있으면 사람, 없으면 기기(id). 사람이 기기를 바꿔도 같은 쪽에 남고,
 * 익명 기기는 토큰이 교체돼도 같은 쪽에 남는다(순수 함수).
 */
export function holdoutKey(row: HoldoutRow): string {
  return row.userId ? `${HOLDOUT_SALT}u:${row.userId}` : `${HOLDOUT_SALT}d:${row.id}`;
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
 * 실험 명단을 남긴다 — 대조군(held)과, 실제로 보낸 발송군(sent). 남기지 않으면 나중에 누가 어느 쪽이었는지
 * 복원할 방법이 없다 — 기기 집합은 계속 변하고 해시만으로는 "그때 대상이었는가"를 되살릴 수 없다.
 * 발송군도 남겨야 두 쪽의 전환을 "발송 뒤 24시간 안"이라는 같은 규칙으로 잴 수 있다.
 * (log, device) 기본키라 재클레임이 같은 페이지를 다시 훑어도 한 행이다.
 */
export async function recordHoldout(
  db: Db,
  log: Pick<PushLog, "id" | "projectId">,
  held: Array<{ id: string; userId: string | null }>,
  sent: Array<{ id: string; userId: string | null }> = []
): Promise<void> {
  const row = (d: { id: string; userId: string | null }, isHeld: boolean) => ({
    projectId: log.projectId,
    logId: log.id,
    deviceId: d.id,
    userId: d.userId,
    held: isHeld,
  });
  const rows = [...held.map((d) => row(d, true)), ...sent.map((d) => row(d, false))];
  if (rows.length === 0) return;
  await db.insert(pushHoldouts).values(rows).onConflictDoNothing();
}

export type HoldoutSubject = { deviceId: string | null; userId: string | null };

/**
 * 이 주체가 최근에 들어간 홀드아웃 실험 발송과 그 쪽(대조군/발송군). 전환 보고가 **클릭이 없을 때** 쓴다 —
 * 대조군은 정의상 푸시를 받지 않았으므로 클릭이 없고, 발송군도 누르지 않고 전환할 수 있다. 두 쪽 모두
 * "발송 뒤 24시간 안의 전환"으로 세야 리프트가 성립한다. 귀속 창 안의 가장 최근 것 하나만 본다.
 */
export async function findExperimentLog(
  db: Db,
  projectId: string,
  subject: HoldoutSubject,
  since: Date
): Promise<{ logId: string; held: boolean } | null> {
  const scope = subject.userId
    ? eq(pushHoldouts.userId, subject.userId)
    : subject.deviceId
      ? eq(pushHoldouts.deviceId, subject.deviceId)
      : null;
  if (!scope) return null;
  const row = (
    await db
      .select({ logId: pushHoldouts.logId, held: pushHoldouts.held })
      .from(pushHoldouts)
      .where(and(eq(pushHoldouts.projectId, projectId), scope, gt(pushHoldouts.createdAt, since)))
      .orderBy(desc(pushHoldouts.createdAt))
      .limit(1)
  )[0];
  return row ?? null;
}

/**
 * 발송군 분모 — 대조군 비율만큼 대상 수를 줄인다(A/B 의 abScale 과 같은 어림).
 * 대조군은 받지 않았으니 클릭할 수도 없다. 전체 대상을 분모로 두면 대조군 20% 인 발송의
 * 클릭률이 20% 낮게 나오고, 로그 목록 순위·통계·CSV 에 그대로 번진다.
 */
export function holdoutScale(a: { users: number; devices: number }, percent: number | null | undefined) {
  if (!percent) return a;
  const keep = (n: number) => Math.round((n * (100 - percent)) / 100);
  return { users: keep(a.users), devices: keep(a.devices) };
}

/** 리프트(%) — 대조군 전환율 대비. 대조군 전환율이 0 이면 비율을 낼 수 없어 null(순수 함수). */
export function conversionLift(sent: { converted: number; total: number }, held: { converted: number; total: number }): number | null {
  if (sent.total === 0 || held.total === 0) return null;
  const heldRate = held.converted / held.total;
  if (heldRate === 0) return null;
  return (sent.converted / sent.total - heldRate) / heldRate;
}
