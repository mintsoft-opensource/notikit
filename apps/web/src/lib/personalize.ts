/**
 * 발송 문구 치환 — `{{변수}}` 를 받는 사람의 값으로 바꾼다.
 *
 * 기본 변수(속성보다 우선):
 * - `{{name}}`        : 사용자 이름(identify 의 name). 없으면 attributes.name
 * - `{{user_id}}`     : 사용자 ID(고객사 서비스의 회원 ID). 예전 이름 `{{external_id}}` 도 된다
 * - `{{app_name}}`    : 프로젝트 이름
 * - `{{date}}` `{{time}}` `{{weekday}}` : 발송 시각을 받는 사람의 시간대·언어로
 *
 * 그 밖의 이름은 identify 로 보낸 attributes 에서 찾는다. `{{변수|기본값}}` 은 값이 없을 때 기본값.
 * 값이 없고 기본값도 없으면 빈 문자열이 된다. 중괄호를 그대로 남기면 받는 사람에게
 * `{{name}}` 이 보이는데, 그건 빈칸보다 나쁘다.
 */

export type Recipient = {
  externalId: string;
  attributes: Record<string, unknown> | null;
  name?: string | null;
  timezone?: string | null;
  locale?: string | null;
} | null;

/** 발송 한 건에 공통인 값 — 받는 사람마다 바뀌지 않는다 */
export type RenderContext = { appName?: string; now?: Date };

export const BUILTIN_VARIABLES = ["name", "user_id", "app_name", "date", "time", "weekday"] as const;

/** 시간대·언어가 없거나 잘못됐을 때 — 콘솔 기본 언어와 서버 기준 시각 */
const DEFAULT_LOCALE = "ko";
const DEFAULT_TIMEZONE = "UTC";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*(?:\|([^}]*))?\}\}/g;

export function hasPlaceholders(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => Boolean(t) && new RegExp(PLACEHOLDER.source).test(t!));
}

function scalar(v: unknown): string {
  // 객체·배열은 문자열로 만들면 "[object Object]" 가 보인다 — 없는 값으로 친다
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** 받는 사람 시간대로 포맷. 잘못된 시간대·언어(예: "Mars/Olympus")는 기본값으로 다시 시도한다. */
function formatNow(recipient: Recipient, now: Date, options: Intl.DateTimeFormatOptions): string {
  // Android·Flutter 의 Locale.toString() 은 "ko_KR" 처럼 밑줄을 쓴다 — Intl 은 하이픈만 받는다
  const locale = (recipient?.locale || DEFAULT_LOCALE).replace(/_/g, "-");
  const timeZone = recipient?.timezone || DEFAULT_TIMEZONE;
  // 언어가 잘못돼도 시간대는 살린다(서울 사용자에게 UTC 시각이 가면 날짜까지 틀린다). 둘 다 안 되면 기본값.
  for (const [loc, tz] of [[locale, timeZone], [DEFAULT_LOCALE, timeZone], [locale, DEFAULT_TIMEZONE]] as const) {
    const fmt = cachedFormat(loc, tz, options);
    if (fmt) return fmt.format(now);
  }
  return cachedFormat(DEFAULT_LOCALE, DEFAULT_TIMEZONE, options)!.format(now);
}

/**
 * Intl.DateTimeFormat 캐시. 생성이 비싸(수십 µs) 수십만 명 개인화 발송에서 사람마다 만들면
 * CPU 가 여기서 대부분 소모된다. 받는 사람의 (언어, 시간대) 조합은 많지 않다.
 * 잘못된 조합(throw)도 null 로 기억해 매번 예외를 다시 던지지 않는다.
 */
const FORMAT_CACHE_MAX = 1000;
const formatCache = new Map<string, Intl.DateTimeFormat | null>();

function cachedFormat(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  const hit = formatCache.get(key);
  if (hit !== undefined) return hit;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch {
    fmt = null;
  }
  // 임의 문자열 시간대가 무한히 쌓이지 않게 상한에서 비운다
  if (formatCache.size >= FORMAT_CACHE_MAX) formatCache.clear();
  formatCache.set(key, fmt);
  return fmt;
}

function valueOf(recipient: Recipient, key: string, ctx: RenderContext): string {
  const now = ctx.now ?? new Date();
  switch (key) {
    case "name":
      return recipient?.name || scalar(recipient?.attributes?.name);
    case "user_id":
    case "external_id": // 예전 이름 — 이미 저장된 템플릿·발송이 계속 쓴다
      return recipient?.externalId ?? "";
    case "app_name":
      return ctx.appName ?? "";
    case "date":
      return formatNow(recipient, now, { month: "long", day: "numeric" });
    case "time":
      return formatNow(recipient, now, { hour: "numeric", minute: "2-digit" });
    case "weekday":
      return formatNow(recipient, now, { weekday: "long" });
    default:
      return scalar(recipient?.attributes?.[key]);
  }
}

export function renderTemplate(template: string, recipient: Recipient, ctx: RenderContext = {}): string {
  return template.replace(PLACEHOLDER, (_, key: string, fallback?: string) => {
    const v = valueOf(recipient, key, ctx);
    return v !== "" ? v : (fallback ?? "").trim();
  });
}
