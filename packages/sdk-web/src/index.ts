import { NotikitClient, NOTIKIT_LOG_ID_KEY, resolveUserId, type NotikitConfig } from "@notikit/core";
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
  /**
   * 포그라운드(탭이 보이는 상태) 메시지 처리. 넘기지 않으면 SDK 가 알림을 띄우고
   * 클릭을 보고한다. 화면 안 토스트로 처리하려면 여기서 직접 다룬다.
   */
  onForegroundMessage?: (data: Record<string, string>) => void;
  /** 서비스워커 경로 (기본 /notikit-sw.js) */
  serviceWorkerPath?: string;
  /** 유저 id — 고객 서비스의 유저 식별자 (로그인 시) */
  userId?: string;
  /** @deprecated `userId` 를 쓴다. 같은 값으로 취급한다. */
  externalId?: string;
  /** user id 바인딩 시 identity 검증 해시(고객 서버가 계산) */
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
  /** 포그라운드 클릭 보고에 쓸 현재 토큰 */
  private lastToken: string | null = null;
  private unsubscribeForeground?: () => void;

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
    const swUrl = this.serviceWorkerUrl();
    await this.evictStaleWorker(swUrl);
    const reg = await navigator.serviceWorker.register(swUrl);
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission denied");

    const token = this.config.getToken
      ? await this.config.getToken(reg)
      : await this.tokenFromFirebase(reg);
    if (!token) throw new Error("FCM registration token unavailable");

    // 워커가 클릭 보고에 쓸 수 있게 남긴다 — 워커에서는 getToken 을 부를 수 없다.
    await this.persistToken(token);

    this.lastToken = token;
    await this.listenForeground();

    await this.client.registerDevice({
      token,
      platform: "web",
      userId: resolveUserId(this.config),
      identityHash: this.config.identityHash,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return token;
  }

  /**
   * 포그라운드 메시지 수신을 시작한다. `register()` 가 자동으로 호출한다.
   *
   * 탭이 보이는 상태에서 온 푸시는 **서비스워커로 가지 않는다** — Firebase 가 창으로
   * 넘기고 `onMessage` 로 뿌린다. 핸들러가 없으면 그 푸시는 알림도 뜨지 않고 클릭도
   * 남지 않은 채 사라진다. 웹은 네이티브와 달리 포그라운드가 흔한 상태라 영향이 크다.
   *
   * 기본 동작은 워커와 같은 모양의 알림을 띄우고, 누르면 딥링크로 이동시키며 클릭을
   * 보고하는 것이다. 화면 안에서 직접 처리하려면 `onForegroundMessage` 를 넘긴다.
   */
  private async listenForeground(): Promise<void> {
    if (this.unsubscribeForeground) return;
    try {
      const [{ getApps, getApp }, { getMessaging, onMessage }] = await Promise.all([
        import("firebase/app"),
        import("firebase/messaging"),
      ]);
      const app = getApps().length ? getApp() : null;
      if (!app) return;

      this.unsubscribeForeground = onMessage(getMessaging(app), (payload) => {
        const data = (payload.data ?? {}) as Record<string, string>;
        const custom = this.config.onForegroundMessage;
        if (custom) return custom(data);

        const logId = data[NOTIKIT_LOG_ID_KEY];
        const destination = data.deep_link || "/";
        // 서버는 웹에 data-only 로 보내므로 제목·본문도 data 에 있다
        const n = new Notification(data.title || "알림", { body: data.body || "", icon: data.icon });
        n.onclick = () => {
          n.close();
          if (logId) void this.reportForegroundClick(logId, destination);
          window.open(destination, "_blank");
        };
      });
    } catch {
      // 포그라운드 수신 실패가 등록을 막지 않는다 — 백그라운드는 워커가 계속 담당한다
    }
  }

  private async reportForegroundClick(logId: string, destination: string): Promise<void> {
    const token = this.lastToken;
    if (!token) return;
    await this.client.reportClick({ logId, token, destination }).catch(() => {});
  }

  /** 포그라운드 수신을 멈춘다. 컴포넌트 정리 시 호출한다. */
  unlisten(): void {
    this.unsubscribeForeground?.();
    this.unsubscribeForeground = undefined;
  }

  /**
   * 토큰 교체. FCM 모듈 API 에는 토큰 갱신 이벤트가 없으므로(v10~v12 확인),
   * 앱이 주기적으로 `getToken()` 을 다시 불러 값이 달라졌을 때 호출한다.
   * 새 토큰으로 register 를 다시 부르면 행이 하나 더 생겨 중복 발송된다.
   */
  async rotateToken(oldToken: string, newToken: string): Promise<void> {
    await this.client.rotateToken(oldToken, newToken, this.config.identityHash);
    await this.persistToken(newToken);
    this.lastToken = newToken;
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

  /** 유저 식별. name 은 치환 변수 {{name}} 과 콘솔 표시에 쓰인다 */
  identify(userId: string, attributes?: Record<string, unknown>, name?: string | null) {
    return this.client.identify({
      userId,
      identityHash: this.config.identityHash,
      name,
      attributes,
      locale: typeof navigator !== "undefined" ? navigator.language : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  /**
   * 전환 보고 — 직전 24시간 안에 이 기기가 클릭한 발송의 성과로 귀속된다.
   * `register()` 로 토큰을 받은 뒤에만 쓸 수 있다(토큰이 없으면 서버가 기기를 찾지 못한다).
   */
  trackConversion(name: string, valueCents?: number) {
    if (!this.lastToken) throw new Error("register() must run before trackConversion()");
    return this.client.trackConversion({ name, valueCents, token: this.lastToken });
  }

  get core(): NotikitClient {
    return this.client;
  }

  /**
   * 설정이 바뀌었는데 옛 워커가 남아 있으면 벗겨낸다.
   *
   * 워커 스크립트 본문은 SDK 버전당 **바이트가 동일**하다. 브라우저는 새로 받은
   * 스크립트가 기존과 바이트까지 같으면 설치하지 않고 버리므로, 이미 돌고 있는
   * 워커는 **최초 설치 때의 쿼리**(= 그때의 api-key·Firebase 설정)를 계속 쓴다.
   * 키를 교체하거나 Firebase 프로젝트를 바꿔도 반영되지 않고, 클릭 보고가 옛 키로
   * 나가 거부돼도 앱에는 아무 오류가 보이지 않는다.
   *
   * 경로가 우리 것과 다르면 **건드리지 않는다** — 앱이 쓰는 다른 워커를 지우면 안 된다.
   */
  private async evictStaleWorker(intended: string): Promise<void> {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const current = reg?.active?.scriptURL;
      if (!reg || !current) return;

      const base = location.href;
      const now = new URL(current, base);
      const next = new URL(intended, base);
      if (now.pathname !== next.pathname) return; // 우리 워커가 아니다

      // 설정 쿼리가 같으면 그대로 둔다
      const same = [...next.searchParams.keys()].every(
        (k) => now.searchParams.get(k) === next.searchParams.get(k)
      );
      if (same) return;

      await reg.unregister();
    } catch {
      // 감지 실패가 등록을 막으면 안 된다 — 옛 설정으로라도 도는 편이 낫다
    }
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

  /**
   * 우리 설정과 **같은 프로젝트**의 Firebase 앱을 찾고, 없으면 만든다.
   *
   * `getApps().length ? getApp() : …` 는 두 가지로 틀린다.
   * 1) 앱이 이름 붙은 것뿐이면(`initializeApp(cfg, "host")`) length 는 1 인데
   *    `getApp()` 은 기본 앱이 없어 `app/no-app` 으로 던진다. 재현 확인.
   * 2) 다른 프로젝트의 기본 앱이 있으면 그걸 그대로 써서 엉뚱한 발신자로 붙는다.
   */
  private firebaseApp<A extends { options: { projectId?: string; appId?: string } }>(
    apps: readonly A[],
    initializeApp: (o: NotikitFirebaseOptions, name?: string) => A
  ): A {
    const want = this.config.firebase;
    const match = apps.find(
      (a) => a.options.projectId === want.projectId && a.options.appId === want.appId
    );
    if (match) return match;
    // 이름을 붙여 만든다 — 기본 앱을 차지하면 호스트 앱의 Firebase 를 밀어낼 수 있다
    return initializeApp(want, "notikit");
  }

  private async tokenFromFirebase(reg: ServiceWorkerRegistration): Promise<string | null> {
    // 동적 import — firebase 는 peer dependency 라, 쓰지 않는 경로에서 모듈 해석이
    // 실패하지 않아야 한다(SSR·테스트에서 이 파일을 import 만 해도 깨지면 안 된다).
    const [{ initializeApp, getApps }, { getMessaging, getToken }] = await Promise.all([
      import("firebase/app"),
      import("firebase/messaging"),
    ]);
    const app = this.firebaseApp(getApps(), initializeApp);
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
