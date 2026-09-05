import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALE_COOKIE, isLocale, RTL_LOCALES } from "./locales";

type Dict = Record<string, unknown>;

/** 2단계 deep merge — 로케일에 없는 키는 en(fallback) 값 사용 */
function mergeMessages(base: Dict, override: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = { ...(base[k] as Dict), ...(v as Dict) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function load(locale: string): Promise<Dict> {
  return (await import(`../../messages/${locale}.json`)).default as Dict;
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const fallback = await load(FALLBACK_LOCALE);
  const messages = locale === FALLBACK_LOCALE ? fallback : mergeMessages(fallback, await load(locale));

  return { locale, messages };
});

export function localeDir(locale: string): "rtl" | "ltr" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}
