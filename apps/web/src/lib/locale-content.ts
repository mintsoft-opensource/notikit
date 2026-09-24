/**
 * 로케일별 제목·본문 — 한 발송이 `{ default, ko, ja, … }` 를 들고 다니다 fan-out 때 고른다.
 *
 * 지금까지 `devices.locale`·`push_users.locale` 은 날짜 포맷에만 쓰였다. 문구 자체가 한 벌이면
 * 다국어 서비스는 발송을 언어 수만큼 쪼개야 하고, 그러면 한 캠페인의 성과가 여러 로그로 흩어진다.
 *
 * **폴백은 반드시 보인다.** 맞는 로케일이 없어 기본 문구를 받은 사람의 수와 그 로케일을 세어
 * 로그에 남긴다. 조용히 떨어뜨리면 "일본어를 넣었다"는 믿음만 남고 실제로는 `ja_JP` 가
 * `ja` 에 안 붙어 아무도 못 받은 상태를 아무도 모른다.
 *
 * 이 파일은 콘솔(브라우저) 번들에도 들어간다 — 화면과 서버가 같은 규칙을 써야 미리보기가
 * 거짓말하지 않는다. db·drizzle 을 import 하지 말 것.
 */

export type LocaleText = { title: string; body: string };
/** 로케일 태그 → 문구. `default` 키는 "맞는 언어가 없을 때" 쓰는 문구다. */
export type LocaleContent = Record<string, LocaleText>;

/** 기본 문구로 떨어진 사람 수 — 전체와 로케일별. 로케일을 모르는 기기는 `""` 로 센다. */
export type LocaleFallback = { total: number; byLocale: Record<string, number> };

export const LOCALE_DEFAULT_KEY = "default";
/** 한 발송이 들고 갈 수 있는 로케일 수 — 페이로드와 화면이 함께 감당할 수 있는 선 */
export const MAX_LOCALE_VARIANTS = 24;
/** BCP-47 태그 상한. 실제로는 "pt-BR" 수준이지만 스크립트·지역이 다 붙으면 길어진다. */
export const LOCALE_TAG_MAX = 35;

const LOCALE_TAG_RE = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})*$/;

/** 로케일 키로 받아들일 수 있는 값인가. `default` 는 특별 키로 통과시킨다. */
export function isLocaleKey(key: string): boolean {
  if (key === LOCALE_DEFAULT_KEY) return true;
  return key.length <= LOCALE_TAG_MAX && LOCALE_TAG_RE.test(key);
}

/**
 * 태그 정규화 — Android·Flutter 의 `Locale.toString()` 은 `ko_KR`, 웹은 `ko-KR` 을 준다.
 * 둘을 같은 값으로 접지 않으면 같은 언어가 서로 다른 키로 갈린다.
 */
export function normalizeLocaleTag(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/_/g, "-").toLowerCase();
}

/** `ko-kr` → `ko`. 지역 없는 태그는 그대로. */
function primarySubtag(tag: string): string {
  const i = tag.indexOf("-");
  return i === -1 ? tag : tag.slice(0, i);
}

export type LocalePick = {
  content: LocaleText;
  /** 실제로 고른 키. 기본 문구로 떨어졌으면 null — 호출부가 폴백을 세는 근거다. */
  matched: string | null;
};

/**
 * 받는 사람의 로케일로 문구 고르기(순수 함수).
 * 정확히 맞는 태그 → 언어만 맞는 태그 → `default` → 발송 본문 순.
 */
export function pickLocaleContent(
  content: LocaleContent | null | undefined,
  locale: string | null | undefined,
  base: LocaleText
): LocalePick {
  if (!content) return { content: base, matched: null };
  const index = new Map(Object.entries(content).map(([k, v]) => [normalizeLocaleTag(k), v]));
  const tag = normalizeLocaleTag(locale);
  if (tag) {
    const exact = index.get(tag);
    if (exact) return { content: exact, matched: tag };
    const primary = index.get(primarySubtag(tag));
    if (primary) return { content: primary, matched: primarySubtag(tag) };
  }
  return { content: index.get(LOCALE_DEFAULT_KEY) ?? base, matched: null };
}

export const EMPTY_LOCALE_FALLBACK: LocaleFallback = { total: 0, byLocale: {} };

/**
 * 한 페이지의 문구 배정 + 폴백 집계(순수 함수).
 *
 * `localeOf` 가 토큰의 로케일을 준다(없으면 null). 폴백은 **정규화 전 원본 태그**로 세지 않는다 —
 * `ja_JP`·`ja-JP`·`JA-jp` 가 각각 한 줄씩 나오면 운영자가 "무엇을 추가해야 하는지"를 읽을 수 없다.
 */
export function resolveLocaleContents<T extends { token: string }>(
  rows: T[],
  localeOf: (token: string) => string | null | undefined,
  content: LocaleContent | null | undefined,
  base: LocaleText
): { contentOf: Map<string, LocaleText>; fallback: LocaleFallback } {
  const contentOf = new Map<string, LocaleText>();
  const byLocale: Record<string, number> = {};
  let total = 0;
  if (!content) return { contentOf, fallback: EMPTY_LOCALE_FALLBACK };
  for (const row of rows) {
    const locale = localeOf(row.token);
    const picked = pickLocaleContent(content, locale, base);
    contentOf.set(row.token, picked.content);
    if (picked.matched !== null) continue;
    total++;
    const key = normalizeLocaleTag(locale);
    byLocale[key] = (byLocale[key] ?? 0) + 1;
  }
  return { contentOf, fallback: { total, byLocale } };
}

/** 페이지마다 나오는 폴백 집계를 누적(순수 함수). */
export function addLocaleFallback(prev: LocaleFallback | undefined, next: LocaleFallback): LocaleFallback {
  if (next.total === 0) return prev ?? EMPTY_LOCALE_FALLBACK;
  const byLocale = { ...(prev?.byLocale ?? {}) };
  for (const [k, n] of Object.entries(next.byLocale)) byLocale[k] = (byLocale[k] ?? 0) + n;
  return { total: (prev?.total ?? 0) + next.total, byLocale };
}

/** 저장된 폴백 집계 해석 — 모양이 틀리면 undefined(없는 것으로 본다). */
export function parseLocaleFallback(v: unknown): LocaleFallback | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.total !== "number" || !Number.isInteger(o.total) || o.total < 0) return undefined;
  const raw = o.byLocale;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const byLocale = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number" && Number.isInteger(e[1]) && e[1] >= 0
    )
  );
  return { total: o.total, byLocale };
}
