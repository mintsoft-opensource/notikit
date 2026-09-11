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
 * 번역이 없는 키를 메울 언어.
 *
 * 한국어로 먼저 개발하고 번역을 나중에 얹는 방식이라 ko 로 둔다. en 이면 ko 에만
 * 추가한 새 키가 다른 로케일에서 통째로 비어(next-intl 이 키 문자열을 그대로 노출)
 * 화면이 깨진다. 각 로케일 파일에 번역이 채워지면 그 값이 이 폴백을 덮어쓴다.
 */
export const FALLBACK_LOCALE: Locale = "ko";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** RTL 언어 (dir 속성용) */
export const RTL_LOCALES = new Set<string>(["ar", "he", "fa"]);

export function isLocale(x: string | undefined | null): x is Locale {
  return !!x && (LOCALE_CODES as string[]).includes(x);
}
