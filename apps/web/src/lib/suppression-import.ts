export const SUPPRESSION_REASONS = ["opt_out", "bounced", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const MAX_IMPORT_ROWS = 5000;
const MAX_ID_LEN = 255;
const MAX_TOKEN_LEN = 4096;

export type ImportRow = { externalId: string | null; token: string | null; reason: SuppressionReason };
export type ParseResult = { rows: ImportRow[]; invalid: number } | { error: string };

function isReason(v: string): v is SuppressionReason {
  return (SUPPRESSION_REASONS as readonly string[]).includes(v);
}

/** 한 줄을 CSV 필드로 — 큰따옴표 안의 쉼표·이스케이프("")를 처리한다 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** 행 하나 검증 — 대상(user_id 또는 token) 하나, 사유는 없으면 manual */
export function toImportRow(raw: { userId?: unknown; token?: unknown; reason?: unknown }, defaultReason: SuppressionReason): ImportRow | null {
  const userId = typeof raw.userId === "string" ? raw.userId.trim() : "";
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (!userId && !token) return null;
  if (userId.length > MAX_ID_LEN || token.length > MAX_TOKEN_LEN) return null;
  const reasonText = typeof raw.reason === "string" ? raw.reason.trim().toLowerCase() : "";
  if (reasonText && !isReason(reasonText)) return null;
  return {
    externalId: userId || null,
    token: userId ? null : token,
    reason: reasonText ? (reasonText as SuppressionReason) : defaultReason,
  };
}

/**
 * CSV → 가져올 행. 첫 줄은 헤더여야 하고 `user_id`(또는 external_id) 나 `token` 열이 있어야 한다.
 * `reason` 열은 선택이다. 형식이 틀린 행은 버리지 않고 세어서 돌려준다(건너뜀으로 보고).
 */
export function parseSuppressionCsv(text: string, defaultReason: SuppressionReason = "manual"): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { error: "CSV is empty" };
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const userCol = header.findIndex((h) => h === "user_id" || h === "external_id");
  const tokenCol = header.indexOf("token");
  const reasonCol = header.indexOf("reason");
  if (userCol === -1 && tokenCol === -1) return { error: "CSV header must include user_id or token" };
  const body = lines.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { error: `at most ${MAX_IMPORT_ROWS} rows` };

  const rows: ImportRow[] = [];
  let invalid = 0;
  for (const line of body) {
    const f = splitCsvLine(line);
    const row = toImportRow(
      {
        userId: userCol >= 0 ? f[userCol] : undefined,
        token: tokenCol >= 0 ? f[tokenCol] : undefined,
        reason: reasonCol >= 0 ? f[reasonCol] : undefined,
      },
      defaultReason
    );
    if (row) rows.push(row);
    else invalid++;
  }
  return { rows, invalid };
}

/** JSON 행 배열 → 가져올 행. `user_id`·`external_id`·`token`·`reason` 을 읽는다 */
export function parseSuppressionJson(input: unknown, defaultReason: SuppressionReason = "manual"): ParseResult {
  if (!Array.isArray(input)) return { error: "rows must be an array" };
  if (input.length === 0) return { error: "rows is empty" };
  if (input.length > MAX_IMPORT_ROWS) return { error: `at most ${MAX_IMPORT_ROWS} rows` };
  const rows: ImportRow[] = [];
  let invalid = 0;
  for (const r of input) {
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const row = toImportRow({ userId: o.user_id ?? o.external_id, token: o.token, reason: o.reason }, defaultReason);
    if (row) rows.push(row);
    else invalid++;
  }
  return { rows, invalid };
}

/** 같은 파일 안의 중복을 합친다 — 먼저 나온 행이 이긴다 */
export function dedupeRows(rows: ImportRow[]): { unique: ImportRow[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: ImportRow[] = [];
  for (const r of rows) {
    const key = r.externalId ? `u:${r.externalId}` : `t:${r.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return { unique, duplicates: rows.length - unique.length };
}
