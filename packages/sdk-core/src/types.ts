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
  /** 프로젝트 api-key */
  apiKey: string;
  /** 프로젝트 api-secret (필수) */
  apiSecret: string;
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
