/** 지원 로케일 (25). label 은 각 언어 자기표기(스위처 표시용). ko/en 완역, 나머지는 en 폴백 baseline. */
export const LOCALES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "it", label: "Italiano" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "th", label: "ไทย" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "tr", label: "Türkçe" },
  { code: "pl", label: "Polski" },
  { code: "nl", label: "Nederlands" },
  { code: "sv", label: "Svenska" },
  { code: "uk", label: "Українська" },
  { code: "fa", label: "فارسی" },
  { code: "he", label: "עברית" },
  { code: "ms", label: "Bahasa Melayu" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code) as Locale[];
export const DEFAULT_LOCALE: Locale = "ko";
/**
 * 원문 언어 — 모든 키가 반드시 존재하는 기준. 한국어로 먼저 개발한다.
 * 여기에만 있는 키는 다른 로케일에서 한국어로 보이지만, 비어서 깨지지는 않는다.
 */
export const BASE_LOCALE: Locale = "ko";

/**
 * 1차 폴백 — 번역이 아직 없는 로케일이 보게 될 언어.
 *
 * ko → en → 요청 로케일 순으로 겹친다(i18n/request.ts). ko 를 직접 폴백으로 쓰면
 * 태국어·아랍어 관리자가 새 화면에서 한국어를 보게 된다. 영어가 낫다.
 */
export const FALLBACK_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** RTL 언어 (dir 속성용) */
export const RTL_LOCALES = new Set<string>(["ar", "he", "fa"]);

export function isLocale(x: string | undefined | null): x is Locale {
  return !!x && (LOCALE_CODES as string[]).includes(x);
}
