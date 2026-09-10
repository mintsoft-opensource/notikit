/**
 * 푸시 토큰 마스킹.
 *
 * 토큰만 알면 클릭 위조·바인딩 해제에 쓸 수 있으므로 관리 API 라도 원문을 내보내지 않는다.
 * 짧은 토큰은 앞8/뒤4 를 보이면 전체가 드러나므로, 길이가 충분할 때만 부분 공개한다.
 */
export function maskToken(token: string): string {
  if (token.length <= 16) return `${"\u2026"}${token.slice(-4)}`;
  return `${token.slice(0, 8)}${"\u2026"}${token.slice(-4)}`;
}

/** Postgres 표현식 버전 — 목록 쿼리에서 원문을 애초에 읽어오지 않기 위해 */
export const MASK_SQL = (col: string) =>
  `case when length(${col}) <= 16 then '\u2026' || right(${col}, 4)
        else left(${col}, 8) || '\u2026' || right(${col}, 4) end`;
