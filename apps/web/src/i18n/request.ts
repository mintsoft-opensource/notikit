import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { BASE_LOCALE, DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALE_COOKIE, isLocale, RTL_LOCALES } from "./locales";

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

/**
 * ko → en → 요청 로케일 순으로 겹친다.
 *
 * ko 를 맨 아래 두는 이유: 한국어로 먼저 개발하므로 ko 에만 있는 키가 생기고,
 * 그런 키는 en 에도 없어 결국 한국어로 표시된다(비어서 깨지지 않는다).
 * en 을 그 위에 두는 이유: 이미 en 까지 번역된 키는 영어로 보여야 한다 —
 * 아직 번역 안 된 태국어·아랍어 관리자에게 한국어보다 영어가 낫다.
 *
 * ko 자체를 요청하면 겹치지 않고 그대로 쓴다. 겹치면 en 이 ko 를 덮어
 * 한국어 사용자가 영어를 보게 된다.
 */
async function resolve(locale: string): Promise<Dict> {
  const ko = await load(BASE_LOCALE);
  if (locale === BASE_LOCALE) return ko;

  const base = mergeMessages(ko, await load(FALLBACK_LOCALE));
  return locale === FALLBACK_LOCALE ? base : mergeMessages(base, await load(locale));
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const messages = await resolve(locale);
  return { locale, messages };
});

export function localeDir(locale: string): "rtl" | "ltr" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}
