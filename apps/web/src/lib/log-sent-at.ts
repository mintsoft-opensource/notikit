import { sql, type SQL } from "drizzle-orm";
import { pushLogs } from "@/db/schema";

/**
 * 발송 로그가 실제로 나가기 시작한 시각(SQL) — 큐잉 시각과 예약 시각 중 늦은 쪽.
 *
 * 예약 발송이나 방해금지로 미뤄진 발송은 큐잉 시각보다 한참 뒤에 나간다. 큐잉 시각을 기준으로
 * 재면 사흘 뒤 예약한 발송을 받자마자 눌러도 "읽기까지 3일"이 되고, 저니 분기 창은 도착하기도
 * 전에 닫힌다. JS 쪽 같은 규칙은 click-eligibility 의 latestSendAt 에 있다.
 */
export function logSentAtSql(): SQL<Date> {
  return sql<Date>`greatest(${pushLogs.createdAt}, coalesce(${pushLogs.scheduledAt}, ${pushLogs.createdAt}))`;
}
