import { NotikitClient, type NotikitConfig } from "@notikit/core";
import { saveToken } from "./token-store.js";

/** 워커용 토큰 저장을 기다려 주는 최대 시간 */
const PERSIST_TIMEOUT_MS = 1000;

/** Firebase 웹 앱 설정. 콘솔의 "웹 앱" 구성값 그대로. 모두 공개값이다. */
export interface NotikitFirebaseOptions {
  apiKey: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  authDomain?: string;
  storageBucket?: string;
}

export interface NotikitWebConfig extends Omit<NotikitConfig, "apiSecret"> {
  /** FCM 웹 푸시 VAPID 공개키. Firebase 콘솔 > 클라우드 메시징 > 웹 푸시 인증서 */
  vapidPublicKey: string;
  /**
   * Firebase 웹 앱 설정. **필수** — 서비스워커가 이 값으로 Firebase 를 초기화해야
   * 백그라운드 메시지를 받는다. 워커에는 앱의 Firebase 인스턴스가 없으므로,
   * getToken 을 직접 넘기더라도 이 설정은 생략할 수 없다.
   */
  firebase: NotikitFirebaseOptions;
  /**
   * 토큰 획득만 앱이 대신한다(권장). 이미 Firebase 를 초기화한 앱에서 SDK 가
   * initializeApp 을 또 부르면 앱이 쓰던 인스턴스와 어긋난다.
   */
  getToken?: (registration: ServiceWorkerRegistration) => Promise<string | null>;
  /**
   * 워커가 불러올 firebase compat SDK 버전. 앱이 설치한 firebase 와 메이저를 맞춘다
   * (기본값은 템플릿의 DEFAULT_FIREBASE_SDK_VERSION).
   */
  firebaseSdkVersion?: string;
  /** 서비스워커 경로 (기본 /notikit-sw.js) */
  serviceWorkerPath?: string;
  /** 유저 식별자 (로그인 시) */
  externalId?: string;
  /** external_id 바인딩 시 identity 검증 해시(고객 서버가 계산) */
  identityHash?: string;
}

/**
 * Notikit Web SDK — FCM 웹 푸시.
 *
 * 토큰은 **FCM 등록 토큰**이다. 서버는 안드로이드·iOS 와 같은 경로(FCM)로 발송하므로
 * 플랫폼별 전송 분기가 필요 없다. 예전에는 `PushSubscription` 을 JSON 으로 직렬화해
 * 토큰으로 썼는데, 그건 FCM 토큰이 아니라 발송이 전부 실패했다.
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

  /** 권한 요청 → FCM 토큰 획득 → 서버 등록. 반환: FCM 등록 토큰 */
  async register(): Promise<string> {
    if (!NotikitWeb.isSupported()) {
      throw new Error("Web Push is not supported in this browser");
    }
    if (!this.config.firebase?.appId) {
      throw new Error("`firebase` config is required (the service worker needs it)");
    }

    // 워커는 설정을 자기 URL 쿼리에서만 읽는다(워커에는 이 인스턴스가 없다).
    // 쿼리를 붙이지 않으면 base/key 가 비어 클릭 보고가 조용히 전부 누락된다.
    const reg = await navigator.serviceWorker.register(this.serviceWorkerUrl());
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission denied");

    const token = this.config.getToken
      ? await this.config.getToken(reg)
      : await this.tokenFromFirebase(reg);
    if (!token) throw new Error("FCM registration token unavailable");

    // 워커가 클릭 보고에 쓸 수 있게 남긴다 — 워커에서는 getToken 을 부를 수 없다.
    await this.persistToken(token);

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

  /**
   * 토큰 교체. FCM 은 토큰을 갱신하므로 `onTokenRefresh` 상당 시점에 호출한다.
   * 새 토큰으로 register 를 다시 부르면 행이 하나 더 생겨 중복 발송된다.
   */
  async rotateToken(oldToken: string, newToken: string): Promise<void> {
    await this.client.rotateToken(oldToken, newToken, this.config.identityHash);
    await this.persistToken(newToken);
  }

  /**
   * 토큰을 워커용 저장소에 남긴다. **등록을 막지 않는다.**
   *
   * 실패는 물론 *무응답*도 삼킨다 — IndexedDB 는 다른 탭이 업그레이드를 붙들고 있거나
   * 시크릿 모드에서 콜백이 아예 안 오는 경우가 있는데, 그대로 await 하면 register()
   * 가 영원히 멈춘다. 클릭 보고 하나보다 등록이 끝나는 게 우선이다.
   */
  private persistToken(token: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, PERSIST_TIMEOUT_MS);
      saveToken(token, this.config.apiKey)
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          done();
        });
    });
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

  private serviceWorkerUrl(): string {
    const path = this.config.serviceWorkerPath ?? "/notikit-sw.js";
    const q = new URLSearchParams({ base: this.config.baseUrl, key: this.config.apiKey });
    // 워커도 Firebase 를 초기화해야 백그라운드 메시지를 받는다. 전부 공개 설정값이다.
    const fb = this.config.firebase;
    q.set("fb_apiKey", fb.apiKey);
    q.set("fb_projectId", fb.projectId);
    q.set("fb_senderId", fb.messagingSenderId);
    q.set("fb_appId", fb.appId);
    if (this.config.firebaseSdkVersion) q.set("fb_ver", this.config.firebaseSdkVersion);
    // 상대 경로 그대로 쓴다 — location 같은 전역에 기대면 SSR·테스트 환경에서 깨진다.
    return `${path}${path.includes("?") ? "&" : "?"}${q}`;
  }

  private async tokenFromFirebase(reg: ServiceWorkerRegistration): Promise<string | null> {
    // 동적 import — firebase 는 peer dependency 라, 쓰지 않는 경로에서 모듈 해석이
    // 실패하지 않아야 한다(SSR·테스트에서 이 파일을 import 만 해도 깨지면 안 된다).
    const [{ initializeApp, getApps, getApp }, { getMessaging, getToken }] = await Promise.all([
      import("firebase/app"),
      import("firebase/messaging"),
    ]);
    const app = getApps().length ? getApp() : initializeApp(this.config.firebase);
    return getToken(getMessaging(app), {
      vapidKey: this.config.vapidPublicKey,
      serviceWorkerRegistration: reg,
    });
  }
}

export * from "@notikit/core";
// 서비스워커 템플릿은 소비자가 /notikit-sw.js 로 호스팅해야 하는 산출물이다.
// 배럴에서 내보내지 않으면 exports 맵이 하위 경로를 막아 접근할 방법이 없다.
export * from "./service-worker.js";
export { NOTIKIT_DB, NOTIKIT_STORE, NOTIKIT_TOKEN_KEY, tokenKey, readToken, saveToken } from "./token-store.js";
