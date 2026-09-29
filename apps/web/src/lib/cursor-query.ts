/** 목록 API 의 다음 쪽 커서 — 서버 keyset(`nextCursor`)이 준 복합 커서. 타임스탬프만으로는 동시각 행이 누락된다 */
export type Cursor = { ts: string; id: string } | null;

/** 커서를 쿼리스트링으로 */
export function cursorQuery(c: Cursor): string {
  return c ? `before=${encodeURIComponent(c.ts)}&before_id=${encodeURIComponent(c.id)}` : "";
}
