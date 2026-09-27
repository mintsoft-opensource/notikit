"use client";

import { useLocale } from "next-intl";

/**
 * 숫자 표기의 단일 출처.
 *
 * `React.useMemo(() => new Intl.NumberFormat(locale), [locale])` 가 파일마다 반복되면
 * 옵션이 조금씩 갈라진다(어떤 화면은 소수 1자리, 어떤 화면은 기본값). 포맷터 생성은
 * 비싼 편이라 컴포넌트마다 memo 를 다시 다는 것도 낭비다 — locale+옵션으로 캐시해 두고
 * 같은 조합이면 같은 인스턴스를 돌려준다(useMemo 없이도 참조가 안정적이다).
 */
const cache = new Map<string, Intl.NumberFormat>();

/** locale 을 생략하면 런타임 기본 로케일 — 서버 유틸(formatBytes 등)이 그대로 쓸 수 있게 둔다 */
export function numberFormat(locale: string | undefined, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ""}|${options ? JSON.stringify(options) : ""}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    cache.set(key, formatter);
  }
  return formatter;
}

/** 현재 로케일의 숫자 포맷터. 옵션은 리터럴로 넘겨도 된다 — 값으로 캐시한다. */
export function useNumberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return numberFormat(useLocale(), options);
}
