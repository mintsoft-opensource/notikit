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
  appVersion?: string;
  osVersion?: string;
  locale?: string;
  timezone?: string;
  country?: string;
}

export interface IdentifyInput {
  externalId: string;
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
