import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * 시간 커서 페이징.
 *
 * 타임스탬프만으로 커서를 잡으면 **같은 시각의 행이 통째로 사라진다**. 예를 들어
 * 무효 토큰 정리는 1000행을 한 INSERT 로 넣는데, `now()` 는 트랜잭션 시작 시각이라
 * 그 1000행의 `at` 이 전부 같다. `< 커서` 로 넘기면 동일 시각의 나머지가 전부 스킵된다.
 *
 * 그래서 (시각, id) 복합 키로 비교한다. id 가 유니크하므로 동률이 없다.
 *
 * 커서 문자열은 마이크로초까지 포함한다. postgres.js 가 timestamptz 를 JS Date 로
 * 파싱하면서 µs 를 버리는데, 그 값을 커서로 되돌리면 절삭된 구간의 행이 또 누락된다.
 */
export function cursorExpr(col: PgColumn): SQL<string> {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export interface Cursor {
  ts: string;
  id: string;
}

/** `?before=<µs ISO>&before_id=<uuid>` 파싱. 하나라도 없거나 형태가 어긋나면 null. */
export function parseCursor(url: URL): Cursor | null {
  const ts = url.searchParams.get("before");
  const id = url.searchParams.get("before_id");
  if (!ts || !id) return null;
  if (Number.isNaN(new Date(ts).getTime())) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { ts, id };
}

/** (col, id) < (커서시각, 커서id) — Postgres 행 비교 */
export function beforeCursor(col: PgColumn, idCol: PgColumn, c: Cursor): SQL {
  return sql`(${col}, ${idCol}) < (${c.ts}::timestamptz, ${c.id}::uuid)`;
}

/** 다음 페이지 커서. 없으면 null. */
export function nextCursor<T extends { cursorTs: string; id: string }>(
  rows: T[],
  hasMore: boolean
): Cursor | null {
  if (!hasMore) return null;
  const last = rows[rows.length - 1];
  return last ? { ts: last.cursorTs, id: last.id } : null;
}
