import {
  type NotikitConfig,
  type RegisterDeviceInput,
  type IdentifyInput,
  type SendInput,
  type ReportClickInput,
  type ApiEnvelope,
  NotikitError,
} from "./types";

export * from "./types";
export * from "./session";

/**
 * Notikit 코어 클라이언트 — 모든 플랫폼 SDK 의 공용 HTTP 계층.
 * 브라우저 / Node / React Native 에서 동작 (fetch 주입 가능).
 */
export class NotikitClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret?: string;
  private readonly _fetch: typeof fetch;

  constructor(config: NotikitConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    const f = config.fetch ?? globalThis.fetch;
    if (!f) throw new Error("fetch is not available — pass config.fetch");
    this._fetch = f.bind(globalThis);
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "api-key": this.apiKey,
    };
    // secret 은 있을 때만 전송 (발송 등 서버 전용 작업). 클라이언트는 미포함.
    if (this.apiSecret) headers["api-secret"] = this.apiSecret;

    const res = await this._fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    let json: ApiEnvelope<T>;
    try {
      json = (await res.json()) as ApiEnvelope<T>;
    } catch {
      throw new NotikitError(`Invalid response (${res.status})`, res.status);
    }
    if (!res.ok || !json.success) {
      throw new NotikitError(json.error ?? `Request failed (${res.status})`, res.status);
    }
    return json.data as T;
  }

  /** 디바이스/토큰 등록·업서트 (external_id 있으면 유저 연결) */
  registerDevice(input: RegisterDeviceInput) {
    return this.request<{ device: unknown }>("/api/v1/devices", {
      token: input.token,
      platform: input.platform,
      external_id: input.externalId,
      identity_hash: input.identityHash,
      app_version: input.appVersion,
      os_version: input.osVersion,
      locale: input.locale,
      timezone: input.timezone,
      country: input.country,
    });
  }

  /** 유저 식별 (identity) */
  identify(input: IdentifyInput) {
    return this.request<{ user: unknown }>("/api/v1/users/identify", {
      external_id: input.externalId,
      identity_hash: input.identityHash,
      attributes: input.attributes,
      locale: input.locale,
      timezone: input.timezone,
    });
  }

  /**
   * 디바이스 바인딩 해제 (로그아웃/계정전환).
   * 해제하지 않으면 이후 클릭이 이전 계정에 계속 귀속된다.
   */
  unbindDevice(token: string, platform: RegisterDeviceInput["platform"], identityHash?: string) {
    return this.request<{ device: unknown }>("/api/v1/devices", {
      token,
      platform,
      external_id: null,
      // 서버가 현재 바인딩된 유저의 해시를 검증한다 — 남의 토큰으로 해제하는 것을 막는다
      identity_hash: identityHash,
    });
  }

  /**
   * 푸시 클릭(알림 탭) 보고.
   * 유저는 서버가 토큰의 바인딩에서 해석하므로 external_id 를 보내지 않는다.
   */
  reportClick(input: ReportClickInput) {
    return this.request<{ recorded: boolean }>("/api/v1/messages/click", {
      log_id: input.logId,
      token: input.token,
      destination: input.destination,
    });
  }

  /** 토픽 구독 */
  subscribe(topic: string, token: string) {
    return this.request<{ subscribed: boolean; topic: string }>(
      "/api/v1/topics/subscribe",
      { topic, token }
    );
  }

  /** 푸시 전송 (서버→디바이스; 보통 백엔드에서 호출) */
  send(input: SendInput) {
    return this.request<{ message: unknown }>("/api/v1/messages", {
      title: input.title,
      body: input.body,
      type: input.type,
      target: input.target,
      deep_link: input.deepLink,
      data: input.data,
    });
  }
}
