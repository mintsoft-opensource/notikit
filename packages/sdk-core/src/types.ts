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

export interface RegisterDeviceInput {
  token: string;
  platform: Platform;
  externalId?: string;
  /** external_id 바인딩 시 identity 검증 해시 = HMAC-SHA256(externalId, apiSecret). 고객 서버가 계산해 전달. */
  identityHash?: string;
  appVersion?: string;
  osVersion?: string;
  locale?: string;
  timezone?: string;
  country?: string;
}

export interface IdentifyInput {
  externalId: string;
  identityHash?: string;
  attributes?: Record<string, unknown>;
  locale?: string;
  timezone?: string;
}

interface SendBase {
  title: string;
  body: string;
  deepLink?: string;
  data?: Record<string, unknown>;
}

/** 판별 유니온 — single/topic 은 target 필수, broadcast 는 선택 */
export type SendInput =
  | (SendBase & { type: "single" | "topic"; target: string })
  | (SendBase & { type: "broadcast"; target?: string });

export interface ReportClickInput {
  /** 푸시 페이로드의 data.notikit_log_id */
  logId: string;
  /** 알림을 받은 디바이스의 푸시 토큰 — 서버가 이 토큰으로 유저를 해석한다 */
  token: string;
  /** 실제 착지한 화면/URL (발송의 deepLink 와 다를 수 있음) */
  destination?: string;
}

/** 푸시 페이로드에서 notikit 이 예약해 쓰는 data 키 */
export const NOTIKIT_LOG_ID_KEY = "notikit_log_id";

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
