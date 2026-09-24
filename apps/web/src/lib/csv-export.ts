/**
 * 스트리밍 CSV 내보내기.
 *
 * 결과를 배열에 모았다가 한 번에 돌려주면 5만 행짜리 내보내기가 그대로 힙에 올라간다 —
 * 동시에 두어 명만 눌러도 웹 프로세스가 죽는다. 그래서 행을 만들면서 바로 흘려보낸다.
 * DB 쪽도 같이 흘러야 의미가 있으므로 `pagedRows()` 로 커서 페이징을 감싸 쓴다.
 */

export type CsvValue = string | number | boolean | null | undefined;

/**
 * 내보내기 행 상한. 넘는 분량은 **잘린다** — 기간을 좁혀서 다시 받아야 한다.
 *
 * 상한이 없으면 90일치 클릭 수백만 행이 한 요청에 붙어 커넥션을 물고 늘어진다.
 * 5만 행은 엑셀·구글시트가 무리 없이 여는 크기이기도 하다.
 */
export const CSV_ROW_LIMIT = 50_000;

/** DB 를 한 번에 몇 행씩 읽을지 — 메모리에 동시에 존재하는 최대 행 수 */
export const CSV_PAGE_SIZE = 1_000;

/** 한 청크로 묶어 내보낼 최소 바이트. 행 하나마다 write 하면 syscall 이 과하다. */
const CHUNK_BYTES = 16 * 1024;

/**
 * 스프레드시트 수식 주입 방어. `=cmd|'/c calc'!A1` 같은 값이 그대로 들어가면
 * 엑셀이 **열자마자 실행**한다. 내보내기는 우리가 저장한 사용자 입력을 되돌려주는
 * 경로라 이 방어가 없으면 우리가 공격 전달자가 된다.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** 값 하나를 CSV 필드로. 큰따옴표·쉼표·줄바꿈이 있으면 감싸고 내부 따옴표는 두 번 쓴다. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  // 제어문자는 따옴표로 감싸도 파서를 흔든다 — 줄바꿈/탭만 남기고 떨군다
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 한 행. CRLF 로 끝낸다 — RFC 4180 이고, 엑셀이 LF 만으로는 열을 잘못 나누는 환경이 있다. */
export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

/**
 * UTF-8 BOM. 없으면 한국어 윈도우 엑셀이 CP949 로 읽어 제목이 전부 깨진다.
 * (BOM 은 파일 맨 앞에 한 번만 — 청크마다 붙이면 본문에 섞인다.)
 */
const BOM = "﻿";

export type CsvStreamOptions = {
  /** 헤더 행 */
  header: readonly string[];
  /** 행 공급자. 게으르게 당겨쓴다 — 상한에 닿으면 그 뒤로는 **요청하지 않는다**. */
  rows: AsyncIterable<readonly CsvValue[]>;
  /** 최대 행 수 (헤더 제외) */
  limit?: number;
  /** 테스트용 청크 경계. 기본 16KB. */
  chunkBytes?: number;
};

/**
 * 행 스트림 → CSV 바이트 스트림.
 *
 * 상한에 닿으면 공급자의 `return()` 을 불러 DB 커서를 바로 닫는다 — 안 닫으면
 * 브라우저가 다운로드를 취소했을 때 트랜잭션이 열린 채로 남는다.
 */
export function csvStream(opts: CsvStreamOptions): ReadableStream<Uint8Array> {
  const limit = opts.limit ?? CSV_ROW_LIMIT;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const encoder = new TextEncoder();
  const iterator = opts.rows[Symbol.asyncIterator]();
  let sent = 0;
  let done = false;
  let buffer = BOM + csvLine(opts.header);

  async function close(): Promise<void> {
    done = true;
    await iterator.return?.().catch(() => undefined);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      while (buffer.length < chunkBytes) {
        // 상한에 닿았으면 **당기지 않는다**. 한 행 더 읽어 보고 버리면 그만큼 DB 를 더 훑는다.
        if (sent >= limit) {
          await close();
          break;
        }
        const next = await iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        buffer += csvLine(next.value);
        sent += 1;
      }
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
      if (done) controller.close();
    },
    async cancel() {
      await close();
    },
  });
}

/**
 * 커서 페이징을 행 스트림으로. `fetchPage` 는 커서 이후 최대 `pageSize` 행을 돌려준다.
 * 전부 모으지 않고 페이지 단위로만 메모리에 올린다.
 */
export async function* pagedRows<TRow, TCursor>(
  fetchPage: (cursor: TCursor | null) => Promise<{ rows: TRow[]; next: TCursor | null }>,
  toValues: (row: TRow) => readonly CsvValue[]
): AsyncGenerator<readonly CsvValue[]> {
  let cursor: TCursor | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const row of page.rows) yield toValues(row);
    if (!page.next || page.rows.length === 0) return;
    cursor = page.next;
  }
}

/** ISO 8601(UTC). 로캘 포맷은 스프레드시트마다 다르게 해석돼 정렬이 깨진다. */
export function csvTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * 첨부 파일 헤더. 파일명에 사용자 입력(프로젝트명 등)을 넣지 않는다 —
 * 헤더 인젝션과 경로 문자 처리를 매번 다시 검증해야 한다. 종류 + 날짜면 충분하다.
 */
export function csvHeaders(name: string, limit = CSV_ROW_LIMIT): HeadersInit {
  // 점까지 떨군다 — `..` 를 남기면 파일명에 상위 경로가 들어간다
  const safe = name.replace(/[^a-z0-9_-]/gi, "-");
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${safe}-${stamp}.csv"`,
    // 잘렸는지 스트림 도중엔 알 수 없다 — 상한을 헤더로 알려 클라이언트가 안내할 수 있게 한다
    "x-export-row-limit": String(limit),
    "cache-control": "no-store",
  };
}
