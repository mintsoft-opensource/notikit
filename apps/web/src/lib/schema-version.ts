import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 스키마가 이 이미지의 코드와 맞는가 — readiness 판정용.
 *
 * `select 1` 만 보면 migrate 가 실패한 채로 새 web 이 떠도 ready 로 보인다. 그러면
 * 업데이터가 그 교체를 "성공"으로 기록하고, 새 코드가 없는 컬럼을 읽다가 요청마다 터진다.
 *
 * drizzle 은 `drizzle.__drizzle_migrations.created_at` 에 저널 항목의 `when` 을 적고,
 * 가장 늦은 값보다 뒤의 항목만 적용한다. 그래서 "적용된 최댓값 ≥ 저널의 최댓값" 이 곧
 * "이 이미지가 기대하는 마이그레이션이 모두 적용됨" 이다. DB 가 더 앞서 있는 것은 통과시킨다 —
 * 마이그레이션 없는 릴리스를 되돌린 직후처럼 정상적인 경우가 있다.
 */

export type SchemaCheck =
  | { ok: true }
  | { ok: false; reason: "schema behind"; applied: number | null; expected: number };

/** 저널의 가장 늦은 `when`. 모양이 어긋나면 null — 기대치를 모르는 채로 판정하지 않는다. */
export function latestJournalMillis(journal: unknown): number | null {
  if (typeof journal !== "object" || journal === null) return null;
  const entries = (journal as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;

  let latest = 0;
  for (const e of entries) {
    const when = (e as { when?: unknown } | null)?.when;
    if (typeof when !== "number" || !Number.isFinite(when)) return null;
    if (when > latest) latest = when;
  }
  return latest;
}

/** `applied` 는 DB 가 돌려준 max(created_at) — bigint 라 문자열로 온다. 없으면 null. */
export function compareSchema(applied: string | number | null, expected: number): SchemaCheck {
  if (expected === 0) return { ok: true };
  const n = applied === null ? null : Number(applied);
  const appliedMillis = n !== null && Number.isFinite(n) ? n : null;
  if (appliedMillis !== null && appliedMillis >= expected) return { ok: true };
  return { ok: false, reason: "schema behind", applied: appliedMillis, expected };
}

/**
 * 이미지에 실린 저널을 읽는다. 이미지 안에서는 불변이므로 한 번만 읽는다.
 * standalone 의 server.js 는 apps/web 으로 chdir 하므로 cwd 기준 `drizzle/` 이 맞다
 * (migrate.mjs 와 같은 DRIZZLE_DIR override 를 따른다).
 */
let cached: { dir: string; value: number } | null = null;

export async function readBundledJournal(
  dir = process.env.DRIZZLE_DIR ?? path.join(process.cwd(), "drizzle")
): Promise<number> {
  if (cached?.dir === dir) return cached.value;
  const raw = await readFile(path.join(dir, "meta", "_journal.json"), "utf8");
  const value = latestJournalMillis(JSON.parse(raw));
  // 저널이 깨졌는데 ready 로 넘기면 이 검사가 있으나 마나다
  if (value === null) throw new Error(`malformed drizzle journal in ${dir}`);
  cached = { dir, value };
  return value;
}
