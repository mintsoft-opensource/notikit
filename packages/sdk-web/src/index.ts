import { NotikitClient, type NotikitConfig } from "@notikit/core";

export interface NotikitWebConfig extends Omit<NotikitConfig, "apiSecret"> {
  /** Web Push VAPID 공개키 (base64url). 서버가 발급 */
  vapidPublicKey: string;
  /** 서비스워커 경로 (기본 /notikit-sw.js) */
  serviceWorkerPath?: string;
  /** 유저 식별자 (로그인 시) */
  externalId?: string;
  /** external_id 바인딩 시 identity 검증 해시(고객 서버가 계산) */
  identityHash?: string;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Notikit Web SDK — 브라우저 Web Push.
 * 서비스워커 등록 → 권한 요청 → PushManager 구독 → 서버에 디바이스 등록.
 */
export class NotikitWeb {
  private readonly client: NotikitClient;
  private readonly config: NotikitWebConfig;

  constructor(config: NotikitWebConfig) {
    this.config = config;
    this.client = new NotikitClient(config);
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in globalThis
    );
  }

  /** 권한 요청 → 구독 → 서버 등록. 반환: 등록된 endpoint(token) */
  async register(): Promise<string> {
    if (!NotikitWeb.isSupported()) {
      throw new Error("Web Push is not supported in this browser");
    }

    const reg = await navigator.serviceWorker.register(
      this.config.serviceWorkerPath ?? "/notikit-sw.js"
    );
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission denied");

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(this.config.vapidPublicKey) as BufferSource,
    });

    const token = JSON.stringify(sub);
    await this.client.registerDevice({
      token,
      platform: "web",
      externalId: this.config.externalId,
      identityHash: this.config.identityHash,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return token;
  }

  /** 유저 식별 */
  identify(externalId: string, attributes?: Record<string, unknown>) {
    return this.client.identify({
      externalId,
      identityHash: this.config.identityHash,
      attributes,
      locale: typeof navigator !== "undefined" ? navigator.language : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  get core(): NotikitClient {
    return this.client;
  }
}

export * from "@notikit/core";
