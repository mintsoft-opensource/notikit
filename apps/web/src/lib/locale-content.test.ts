import { describe, it, expect } from "vitest";
import {
  addLocaleFallback,
  isLocaleKey,
  normalizeLocaleTag,
  parseLocaleFallback,
  pickLocaleContent,
  resolveLocaleContents,
  type LocaleContent,
} from "./locale-content";

const BASE = { title: "Hello", body: "World" };
const CONTENT: LocaleContent = {
  default: { title: "Hi", body: "There" },
  ko: { title: "안녕", body: "반가워" },
  "ja-JP": { title: "こんにちは", body: "よろしく" },
};

describe("로케일 문구 선택", () => {
  it("정확히 맞는 태그 → 언어만 맞는 태그 → default 순으로 고른다", () => {
    expect(pickLocaleContent(CONTENT, "ko", BASE)).toEqual({ content: CONTENT.ko, matched: "ko" });
    // ko-KR 은 정확히 없지만 ko 가 있다 — 지역이 다르다고 기본 문구로 떨어뜨리지 않는다
    expect(pickLocaleContent(CONTENT, "ko-KR", BASE)).toEqual({ content: CONTENT.ko, matched: "ko" });
    expect(pickLocaleContent(CONTENT, "fr", BASE)).toEqual({ content: CONTENT.default, matched: null });
  });

  it("Android·Flutter 의 밑줄 표기(ko_KR)를 하이픈과 같은 값으로 접는다", () => {
    // 접지 않으면 같은 언어가 플랫폼에 따라 갈려 절반이 조용히 기본 문구를 받는다
    expect(pickLocaleContent(CONTENT, "ja_JP", BASE).content).toEqual(CONTENT["ja-JP"]);
    expect(pickLocaleContent(CONTENT, "JA-jp", BASE).content).toEqual(CONTENT["ja-JP"]);
    expect(normalizeLocaleTag("ko_KR")).toBe("ko-kr");
  });

  it("default 가 없으면 발송 본문이 기본 문구다", () => {
    const noDefault: LocaleContent = { ko: CONTENT.ko };
    expect(pickLocaleContent(noDefault, "fr", BASE)).toEqual({ content: BASE, matched: null });
    expect(pickLocaleContent(null, "ko", BASE)).toEqual({ content: BASE, matched: null });
  });

  it("로케일 키 형식을 가린다", () => {
    expect(isLocaleKey("default")).toBe(true);
    expect(isLocaleKey("pt-BR")).toBe(true);
    expect(isLocaleKey("zh_Hant_TW")).toBe(true);
    expect(isLocaleKey("한국어")).toBe(false);
    expect(isLocaleKey("k")).toBe(false);
  });
});

describe("폴백 관측", () => {
  it("기본 문구로 떨어진 사람 수를 로케일별로 센다 — 조용한 폴백은 믿을 수 없다", () => {
    const rows = [{ token: "a" }, { token: "b" }, { token: "c" }, { token: "d" }];
    const locales = new Map([["a", "ko"], ["b", "fr"], ["c", "fr-CA"], ["d", null as string | null]]);
    const { contentOf, fallback } = resolveLocaleContents(rows, (t) => locales.get(t), CONTENT, BASE);

    expect(contentOf.get("a")).toEqual(CONTENT.ko);
    expect(contentOf.get("b")).toEqual(CONTENT.default);
    // fr 과 fr-CA 는 같은 fr 이 없으므로 각자의 정규화 태그로 센다. 로케일을 모르는 기기는 "".
    expect(fallback).toEqual({ total: 3, byLocale: { fr: 1, "fr-ca": 1, "": 1 } });
  });

  it("로케일 변형이 없는 발송은 문구 배정도 집계도 하지 않는다", () => {
    const { contentOf, fallback } = resolveLocaleContents([{ token: "a" }], () => "ko", null, BASE);
    expect(contentOf.size).toBe(0);
    expect(fallback.total).toBe(0);
  });

  it("페이지마다 나오는 집계를 누적하고, 0건은 상태를 건드리지 않는다", () => {
    const first = addLocaleFallback(undefined, { total: 2, byLocale: { fr: 2 } });
    const second = addLocaleFallback(first, { total: 3, byLocale: { fr: 1, de: 2 } });
    expect(second).toEqual({ total: 5, byLocale: { fr: 3, de: 2 } });
    expect(addLocaleFallback(second, { total: 0, byLocale: {} })).toBe(second);
  });

  it("저장된 집계가 깨졌으면 없는 것으로 본다 — 틀린 수를 화면에 올리지 않는다", () => {
    expect(parseLocaleFallback({ total: 2, byLocale: { fr: 2 } })).toEqual({ total: 2, byLocale: { fr: 2 } });
    expect(parseLocaleFallback({ total: -1, byLocale: {} })).toBeUndefined();
    expect(parseLocaleFallback({ total: 1 })).toBeUndefined();
    expect(parseLocaleFallback(null)).toBeUndefined();
    expect(parseLocaleFallback({ total: 1, byLocale: { fr: "x" } })).toEqual({ total: 1, byLocale: {} });
  });
});
