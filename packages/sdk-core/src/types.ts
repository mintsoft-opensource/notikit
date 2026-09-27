export type Platform =
  | "android"
  | "ios"
  | "web"
  | "webview"
  | "electron"
  | "flutter"
  | "react-native";

export interface NotikitConfig {
  /** Notikit 서버 base URL, 예: https://push.example.com */
  baseUrl: string;
  /** 프로젝트 api-key (공개키 — 클라이언트 SDK 안전) */
  apiKey: string;
  /**
   * 프로젝트 api-secret — 발송(send) 등 **서버 전용** 작업에만 필요.
   * ⚠️ 브라우저/모바일 앱 SDK 에는 절대 포함하지 말 것(노출 위험). 등록/식별/구독은 api-key 만으로 동작.
   */
  apiSecret?: string;
  /** fetch 구현 주입 (RN/Node 커스텀). 기본 globalThis.fetch */
  fetch?: typeof fetch;
}

/**
 * 고객 서비스의 유저 id 로 사람을 가리킨다. `externalId` 는 이전 이름이며 같은 뜻이다.
 * 둘 다 주면 `userId` 가 이긴다.
 */
export interface UserIdFields {
  /** 고객 서비스의 유저 id */
  userId?: string;
  /** @deprecated `userId` 를 쓴다. 같은 값으로 취급한다. */
  externalId?: string;
}

/** 이름이 바뀐 두 필드 중 실제로 쓸 유저 id — `userId ?? externalId` */
export function resolveUserId(input: UserIdFields | null | undefined): string | undefined {
  return input?.userId ?? input?.externalId;
}

/** 유저 id 가 반드시 있어야 하는 입력 — `userId` 또는 (deprecated) `externalId` 중 하나 */
export type RequiredUserId =
  | { userId: string; /** @deprecated `userId` 를 쓴다. */ externalId?: string }
  | { /** @deprecated `userId` 를 쓴다. */ externalId: string; userId?: undefined };

function requiredUserId(input: RequiredUserId): string {
  return (input.userId ?? input.externalId) as string;
}

export interface RegisterDeviceInput extends UserIdFields {
  token: string;
  platform: Platform;
  /** user_id 바인딩 시 identity 검증 해시 = HMAC-SHA256(userId, apiSecret). 고객 서버가 계산해 전달. */
  identityHash?: string;
  appVersion?: string;
  osVersion?: string;
  locale?: string;
  timezone?: string;
  country?: string;
}

export type IdentifyInput = RequiredUserId & {
  identityHash?: string;
  /** 표시·치환({{name}})용 이름. null 이면 지운다. */
  name?: string | null;
  attributes?: Record<string, unknown>;
  locale?: string;
  timezone?: string;
};

/**
 * 내용은 직접 쓰거나(title·body) 콘솔 템플릿 이름으로 부른다.
 * 템플릿과 함께 title·body 를 주면 그 값이 템플릿보다 우선한다.
 */
type SendContent =
  | { title: string; body: string; template?: undefined; fields?: undefined }
  | {
      /** 콘솔 > 발송 > 템플릿 에서 만든 템플릿 이름 */
      template: string;
      /** 템플릿이 정의한 커스텀 필드 값 → 푸시 data. 정의에 없는 키는 422 */
      fields?: Record<string, string>;
      title?: string;
      body?: string;
    }
  // 무음 푸시는 알림을 그리지 않으므로 제목·본문 없이 data 만 보낼 수 있다
  | { options: PushOptions & { silent: true }; title?: string; body?: string; template?: undefined; fields?: undefined };

/** 알림 액션 버튼. 앱 SDK 가 받은 푸시에서 `readPushData(data).actions` 로 읽는다. */
export interface PushAction {
  /** 앱이 어떤 버튼을 눌렀는지 구분하는 값 */
  id: string;
  title: string;
  /** 이 버튼으로 이동할 곳. 없으면 발송의 deepLink 를 쓴다 */
  deepLink?: string;
}

/** 발송 한 건의 알림 옵션. 서버가 Android·APNs·웹 페이로드의 제자리에 나눠 싣는다. */
export interface PushOptions {
  /** 알림음 파일명 또는 "default" */
  sound?: string;
  /** iOS 앱 아이콘 배지 수 (0 이상) */
  badge?: number;
  /** 같은 키의 이전 알림을 덮어쓴다 */
  collapseKey?: string;
  androidChannelId?: string;
  iosThreadId?: string;
  /** 배달 유효기간(초). 0 이면 지금 못 받는 기기에는 버린다. 최대 28일(2419200). */
  ttlSeconds?: number;
  /** 기본 high */
  priority?: "normal" | "high";
  /** 무음 푸시 — 알림 없이 data 만 보낸다 */
  silent?: boolean;
  /** 액션 버튼(최대 3개) */
  actions?: PushAction[];
}

/** PushOptions → 요청 본문(snake_case). 값이 없는 키는 보내지 않는다. */
export function pushOptionsBody(o: PushOptions | undefined): Record<string, unknown> | undefined {
  if (!o) return undefined;
  const body: Record<string, unknown> = {
    sound: o.sound,
    badge: o.badge,
    collapse_key: o.collapseKey,
    android_channel_id: o.androidChannelId,
    ios_thread_id: o.iosThreadId,
    ttl_seconds: o.ttlSeconds,
    priority: o.priority,
    silent: o.silent,
    actions: o.actions?.map((a) => ({ id: a.id, title: a.title, ...(a.deepLink ? { deep_link: a.deepLink } : {}) })),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return Object.keys(body).length ? body : undefined;
}

type SendBase = SendContent & {
  deepLink?: string;
  /** 알림에 크게 붙는 이미지. https 만 받는다(http 는 422). */
  imageUrl?: string;
  data?: Record<string, unknown>;
  /** 예약 발송 시각. Date 또는 ISO 8601 문자열 — 없으면 즉시(방해금지 시간대 규칙은 적용) */
  scheduledAt?: Date | string;
  /** A/B 변형(2~5개). 받는 사람마다 하나가 골라져 발송된다 */
  variants?: SendVariant[];
  /** 푸시 실패 시 카카오 알림톡으로 대체 발송 */
  kakaoFallback?: boolean;
  /** 재시도해도 한 번만 발송되도록 붙이는 키 — `Idempotency-Key` 헤더로 보낸다 */
  idempotencyKey?: string;
  /** 알림 옵션(소리·배지·TTL·우선순위·무음·액션 버튼) */
  options?: PushOptions;
};

export interface SendVariant {
  title: string;
  body: string;
}

/**
 * 판별 유니온 — single/topic 은 target 필수, multi 는 targets(user id 목록) 필수, broadcast 는 선택.
 * title/body 에 `{{속성}}` 을 쓰면 받는 사람의 값으로 치환된다.
 */
export type SendInput =
  | (SendBase & { type: "single" | "topic"; target: string })
  | (SendBase & { type: "multi"; targets: string[] })
  | (SendBase & { type: "broadcast"; target?: string });

/**
 * 토픽 구독·해지 대상.
 *
 * 문자열이면 토큰이다 — 기존 `subscribe(topic, token)` 호출을 그대로 살리기 위해서다.
 * 백엔드에서 "이 사람을" 넣고 뺄 때는 `{ userId }` 를 쓴다(이전 이름 `{ externalId }` 도 동작).
 * 그 사람의 활성 기기 전부가 대상이 되므로, 기기 목록을 백엔드가 따로 관리하지 않아도 된다.
 * 공개 api-key 만으로 남의 기기를 넣고 빼지 못하도록 identityHash 가 필수다.
 */
export type SubscribeTarget = string | { token: string } | (RequiredUserId & { identityHash: string });

export interface TopicMembershipResult {
  topic: string;
  /** 대상으로 잡힌 기기 수 */
  devices: number;
  /** 실제로 추가된 구독 수 (이미 구독 중이면 0) */
  added?: number;
  /** 실제로 제거된 구독 수 */
  removed?: number;
  subscribed?: boolean;
  unsubscribed?: boolean;
}

/** SubscribeTarget → 요청 본문. 서버는 token 과 user_id 중 정확히 하나를 요구한다. */
export function targetBody(
  target: SubscribeTarget
): { token: string } | { user_id: string; identity_hash: string } {
  if (typeof target === "string") return { token: target };
  if ("token" in target) return { token: target.token };
  return { user_id: requiredUserId(target), identity_hash: target.identityHash };
}

/**
 * 수신 보고 입력. 토큰이 필요한 이유는 클릭 보고와 같다 — 서버가 이 토큰으로 기기를 찾고,
 * 그 기기가 정말 이 발송의 수신자였는지 검사한다(아무 토큰으로 도달 수를 부풀리지 못하게).
 */
export interface ReportReceivedInput {
  /** 푸시 페이로드의 data.notikit_log_id */
  logId: string;
  /** 알림을 받은 디바이스의 푸시 토큰 — 등록할 때 쓴 것과 같아야 한다 */
  token: string;
}

export interface ReportClickInput {
  /** 푸시 페이로드의 data.notikit_log_id */
  logId: string;
  /** 알림을 받은 디바이스의 푸시 토큰 — 서버가 이 토큰으로 유저를 해석한다 */
  token: string;
  /** 실제 착지한 화면/URL (발송의 deepLink 와 다를 수 있음) */
  destination?: string;
}

/**
 * 전환 보고 입력. 대상은 토큰(알림을 받은 기기) 또는 userId 중 **정확히 하나**다.
 * userId 로 보낼 때는 identityHash 가 필수 — 공개 api-key 만으로 남의 전환을 심지 못하게 한다.
 */
export type TrackConversionInput = {
  /** 전환 이름 — "purchase", "signup" 같은 짧은 식별자(최대 64자) */
  name: string;
  /** 금액(최소 화폐 단위, 예: 원). 금액이 없는 전환은 생략 */
  valueCents?: number;
} & (
  | { token: string; userId?: undefined; externalId?: undefined; identityHash?: undefined }
  | (RequiredUserId & { identityHash: string; token?: undefined })
);

export interface TrackConversionResult {
  /** 실제로 저장됐는가. 같은 날 같은 (발송, 사람, 이름)이 이미 있으면 false. */
  recorded: boolean;
  /** 최근 24시간 안의 클릭에 귀속됐는가. false 면 아무것도 저장하지 않았다. */
  attributed: boolean;
  /** 귀속된 발송 id */
  message_id?: string;
}

/** 푸시 페이로드에서 notikit 이 예약해 쓰는 data 키 */
export const NOTIKIT_LOG_ID_KEY = "notikit_log_id";

/**
 * 푸시 data 에서 notikit·FCM·APNs 가 쓰는 키. 이것을 뺀 나머지가 발송 때 넣은 커스텀 필드다.
 * 서버가 필드 키로 쓰지 못하게 막는 목록과 같다.
 */
const INTERNAL_KEYS = new Set(["deep_link", "notikit_log_id", "actions", "title", "body", "icon", "image", "aps", "from", "collapse_key", "notification", "message_type", "fcm_options"]);
const INTERNAL_PREFIXES = ["google.", "gcm."];

export interface NotikitPushData {
  /** 발송 id — 없으면 notikit 발송이 아니다 */
  logId?: string;
  deepLink?: string;
  /** 발송 때 넣은 커스텀 필드(템플릿 필드 포함). 값은 항상 문자열이다. */
  custom: Record<string, string>;
  /** 발송이 붙인 액션 버튼. 없으면 빈 배열. */
  actions: PushAction[];
}

/**
 * `data.actions`(JSON 문자열) → 액션 버튼.
 * 모양이 틀린 값은 통째로 버린다 — 반쪽짜리 버튼을 그리면 눌러도 앱이 처리하지 못한다.
 */
function parseActions(raw: unknown): PushAction[] {
  if (typeof raw !== "string" || !raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const a = x as { id?: unknown; title?: unknown; deep_link?: unknown; deepLink?: unknown };
    if (typeof a?.id !== "string" || typeof a?.title !== "string") return [];
    const deepLink = typeof a.deep_link === "string" ? a.deep_link : typeof a.deepLink === "string" ? a.deepLink : undefined;
    return [{ id: a.id, title: a.title, ...(deepLink ? { deepLink } : {}) }];
  });
}

/** 수신한 푸시 data(FCM RemoteMessage.data, 서비스워커 payload.data 등)를 읽는다 */
export function readPushData(data: unknown): NotikitPushData {
  if (!data || typeof data !== "object") return { custom: {}, actions: [] };
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (INTERNAL_KEYS.has(k) || INTERNAL_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (typeof v === "string") custom[k] = v;
  }
  const deepLink = (data as Record<string, unknown>).deep_link;
  return {
    logId: logIdFromPayload(data),
    deepLink: typeof deepLink === "string" && deepLink ? deepLink : undefined,
    custom,
    actions: parseActions((data as Record<string, unknown>).actions),
  };
}

/** 수신 페이로드의 data 에서 발송 id 추출 — 없으면 notikit 발송이 아니다 */
export function logIdFromPayload(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[NOTIKIT_LOG_ID_KEY];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
  meta?: Record<string, unknown>;
}

export class NotikitError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "NotikitError";
  }
}
