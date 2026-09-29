import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { latestJournalMillis, compareSchema, readBundledJournal } from "@/lib/schema-version";

const journal = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, when: 1000, tag: "0000_a" },
    { idx: 1, when: 3000, tag: "0001_b" },
    { idx: 2, when: 2000, tag: "0002_c" },
  ],
};

describe("latestJournalMillis", () => {
  it("저널 항목 중 가장 늦은 when 을 고른다 — drizzle 이 적용 여부를 이 값으로 판정한다", () => {
    expect(latestJournalMillis(journal)).toBe(3000);
  });

  it("모양이 어긋난 저널은 null — 기대치를 모르면 판정하지 않는다", () => {
    expect(latestJournalMillis(null)).toBeNull();
    expect(latestJournalMillis({ entries: "x" })).toBeNull();
    expect(latestJournalMillis({ entries: [{ when: "soon" }] })).toBeNull();
  });

  it("빈 저널은 0 — 적용할 것이 없다", () => {
    expect(latestJournalMillis({ entries: [] })).toBe(0);
  });
});

describe("compareSchema", () => {
  it("적용된 마지막 마이그레이션이 번들 저널과 같으면 ready", () => {
    expect(compareSchema("3000", 3000)).toEqual({ ok: true });
  });

  it("DB 가 더 앞서 있어도 ready — 롤백 직후 구버전 코드가 뜨는 경우다", () => {
    expect(compareSchema("4000", 3000)).toEqual({ ok: true });
  });

  it("적용된 것이 저널보다 뒤처지면 unready — migrate 가 실패했는데 web 이 뜬 경우다", () => {
    expect(compareSchema("2000", 3000)).toEqual({ ok: false, reason: "schema behind", applied: 2000, expected: 3000 });
  });

  it("마이그레이션 테이블이 비었거나 없으면 unready", () => {
    expect(compareSchema(null, 3000)).toEqual({ ok: false, reason: "schema behind", applied: null, expected: 3000 });
  });

  it("번들 저널이 비어 있으면 적용 이력이 없어도 ready", () => {
    expect(compareSchema(null, 0)).toEqual({ ok: true });
  });
});

describe("readBundledJournal", () => {
  it("이미지에 실리는 실제 저널을 읽는다", async () => {
    const dir = path.join(process.cwd(), "drizzle");
    const onDisk = JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8"));
    const expected = Math.max(...onDisk.entries.map((e: { when: number }) => e.when));
    expect(await readBundledJournal(dir)).toBe(expected);
  });

  it("저널이 없으면 던진다 — 조용히 ready 로 넘기지 않는다", async () => {
    await expect(readBundledJournal("/nonexistent-notikit-drizzle")).rejects.toThrow();
  });
});
