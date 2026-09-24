import { describe, it, expect } from "vitest";
import { csvField, csvLine, csvStream, csvTimestamp, csvHeaders, pagedRows, CSV_ROW_LIMIT } from "./csv-export";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  // ignoreBOM 을 켜야 한다 — 기본 디코더는 선두 BOM 을 조용히 먹어 검증이 무의미해진다
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** 몇 행을 실제로 당겨 갔는지 세는 공급자 */
function countingRows(total: number) {
  const state = { pulled: 0 };
  async function* gen() {
    for (let i = 0; i < total; i++) {
      state.pulled++;
      yield [String(i)];
    }
  }
  return { state, rows: gen() };
}

describe("csvField", () => {
  it("쉼표·따옴표·줄바꿈이 있으면 감싸고 내부 따옴표를 두 번 쓴다", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("수식으로 시작하는 값을 무력화한다 — 엑셀이 열자마자 실행한다", () => {
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvField("+1234")).toBe("'+1234");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("-5")).toBe("'-5");
    // 수식이면서 쉼표까지 있으면 따옴표로도 감싼다
    expect(csvField("=SUM(A1,B1)")).toBe(`"'=SUM(A1,B1)"`);
  });

  it("null·undefined 는 빈 칸, 숫자·불리언은 문자열로", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(0)).toBe("0");
    expect(csvField(false)).toBe("false");
  });

  it("제어문자를 떨궈 파서가 흔들리지 않게 한다", () => {
    expect(csvField("a\u0000b\u001Fc")).toBe("abc");
  });

  it("행은 CRLF 로 끝난다", () => {
    expect(csvLine(["a", "b"])).toBe("a,b\r\n");
  });
});

describe("csvStream", () => {
  it("BOM 과 헤더로 시작한다 — 없으면 한국어 윈도우 엑셀이 제목을 깨뜨린다", async () => {
    const { rows } = countingRows(2);
    const text = await readAll(csvStream({ header: ["n"], rows }));
    expect(text.startsWith("﻿n\r\n")).toBe(true);
    expect(text).toBe("﻿n\r\n0\r\n1\r\n");
  });

  it("상한을 넘는 행은 **당기지도 않는다** — 넘겨보고 버리면 그만큼 DB 를 더 훑는다", async () => {
    const { state, rows } = countingRows(1000);
    const text = await readAll(csvStream({ header: ["n"], rows, limit: 10 }));
    expect(state.pulled).toBe(10);
    expect(text.trimEnd().split("\r\n")).toHaveLength(11); // 헤더 + 10
  });

  it("상한에 닿으면 공급자의 return() 을 불러 커서를 닫는다", async () => {
    let closed = false;
    async function* gen() {
      try {
        for (let i = 0; i < 100; i++) yield [String(i)];
      } finally {
        closed = true;
      }
    }
    await readAll(csvStream({ header: ["n"], rows: gen(), limit: 3 }));
    expect(closed).toBe(true);
  });

  it("다운로드를 취소해도 공급자를 닫는다", async () => {
    let closed = false;
    async function* gen() {
      try {
        for (let i = 0; i < 100; i++) yield [String(i)];
      } finally {
        closed = true;
      }
    }
    const stream = csvStream({ header: ["n"], rows: gen(), chunkBytes: 1 });
    const reader = stream.getReader();
    await reader.read(); // 헤더 청크 — 아직 공급자를 건드리지 않는다
    await reader.read(); // 첫 데이터 청크 — 여기서 공급자가 시작된다
    await reader.cancel();
    expect(closed).toBe(true);
  });

  it("전부 모았다가 내보내지 않는다 — 첫 청크가 나올 때 공급자는 아직 끝나지 않았다", async () => {
    const { state, rows } = countingRows(500);
    const reader = csvStream({ header: ["n"], rows, chunkBytes: 1 }).getReader();
    const first = await reader.read();
    // 헤더가 먼저 나간다 — 500행을 다 읽고 나서야 첫 바이트가 나오는 게 아니다
    expect(state.pulled).toBe(0);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(first.value)).toBe("\ufeffn\r\n");

    await reader.read();
    const afterData = state.pulled;
    expect(afterData).toBeGreaterThan(0);
    expect(afterData).toBeLessThan(500); // 전부 모아두지 않았다
    await reader.cancel();
  });

  it("행이 하나도 없어도 헤더만 있는 올바른 CSV 를 낸다", async () => {
    async function* empty(): AsyncGenerator<string[]> {}
    expect(await readAll(csvStream({ header: ["a", "b"], rows: empty() }))).toBe("﻿a,b\r\n");
  });

  it("기본 상한은 문서화된 CSV_ROW_LIMIT 이다", () => {
    expect(CSV_ROW_LIMIT).toBe(50_000);
    expect(csvHeaders("notikit-audit")).toMatchObject({ "x-export-row-limit": "50000" });
  });
});

describe("pagedRows", () => {
  it("페이지 단위로만 읽고, 덜 찬 페이지에서 멈춘다", async () => {
    const pages = [
      { rows: [1, 2], next: "c1" as string | null },
      { rows: [3], next: null as string | null },
    ];
    const asked: (string | null)[] = [];
    const gen = pagedRows<number, string>(
      async (cursor) => {
        asked.push(cursor);
        return pages.shift()!;
      },
      (n) => [n]
    );
    const out: unknown[] = [];
    for await (const r of gen) out.push(r);
    expect(out).toEqual([[1], [2], [3]]);
    expect(asked).toEqual([null, "c1"]);
  });
});

describe("csvTimestamp / csvHeaders", () => {
  it("시각은 항상 ISO(UTC) — 로캘 포맷은 스프레드시트마다 다르게 읽힌다", () => {
    expect(csvTimestamp(new Date("2026-09-24T01:02:03.000Z"))).toBe("2026-09-24T01:02:03.000Z");
    expect(csvTimestamp(null)).toBe("");
    expect(csvTimestamp("not-a-date")).toBe("");
  });

  it("파일명에 경로·따옴표 문자가 섞이지 않는다", () => {
    const h = csvHeaders('../../etc/pa"sswd') as Record<string, string>;
    expect(h["content-disposition"]).not.toContain("..");
    expect(h["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9.\-]+\.csv"$/i);
  });
});
