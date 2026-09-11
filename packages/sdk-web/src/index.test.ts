import { describe, it, expect, vi, afterEach } from "vitest";
import { NotikitWeb } from "./index";
import { NotikitClient, NotikitError } from "@notikit/core";

function mockFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

const okFetch = () => mockFetch({ success: true, data: { device: { id: "d1" } }, error: null });

const FCM_TOKEN = "fcm-token-1";

// getToken 주입으로 firebase 모듈 없이 검증한다. 실제 firebase 경로의 시그니처는
// devDependency 의 타입이 컴파일 시점에 잡는다.
const base = {
  baseUrl: "https://push.test",
  apiKey: "nk_test",
  vapidPublicKey: "q_-A",
  // 워커가 이 값으로 Firebase 를 초기화해야 백그라운드 메시지를 받는다 — 필수다
  firebase: {
    apiKey: "AIza-test",
    projectId: "p-test",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abc",
  },
  getToken: async () => FCM_TOKEN,
};

function installBrowserEnv({
  permission = "granted",
  existingScriptURL = null,
}: { permission?: string; existingScriptURL?: string | null } = {}) {
  const unregister = vi.fn(async () => true);
  const existingReg = existingScriptURL
    ? ({ active: { scriptURL: existingScriptURL }, unregister } as unknown as ServiceWorkerRegistration)
    : undefined;
  const getRegistration = vi.fn(async () => existingReg);

  const registration = {};
  const swRegister = vi.fn(async () => registration);
  const requestPermission = vi.fn(async () => permission);

  vi.stubGlobal("navigator", {
    language: "ko-KR",
    serviceWorker: { register: swRegister, ready: Promise.resolve(registration), getRegistration },
  });
  vi.stubGlobal("location", { href: "https://site.test/app" });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { requestPermission });
  // saveToken 은 best-effort 다. 여기서는 열기 실패로 응답시켜, 등록이 그대로
  // 진행되는지(그리고 멈추지 않는지) 확인한다.
  const idbOpen = vi.fn(() => {
    const req: Record<string, unknown> = { error: new Error("no idb") };
    setTimeout(() => (req.onerror as (() => void) | null)?.(), 0);
    return req;
  });
  vi.stubGlobal("indexedDB", { open: idbOpen });

  return { swRegister, requestPermission, idbOpen, unregister, getRegistration };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotikitWeb.isSupported", () => {
  it("returns false when the browser has no service worker support", () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    vi.stubGlobal("PushManager", class {});

    expect(NotikitWeb.isSupported()).toBe(false);
  });

  it("returns true when service worker and PushManager are both present", () => {
    installBrowserEnv();

    expect(NotikitWeb.isSupported()).toBe(true);
  });
});

describe("NotikitWeb.register", () => {
  it("throws when web push is not supported", async () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    vi.stubGlobal("PushManager", undefined);
    const notikit = new NotikitWeb({ ...base, fetch: okFetch() });

    await expect(notikit.register()).rejects.toThrow("Web Push is not supported");
  });

  it("registers the default service worker path when none is configured", async () => {
    const env = installBrowserEnv();
    const notikit = new NotikitWeb({ ...base, fetch: okFetch() });

    await notikit.register();

    // 워커는 설정을 자기 URL 쿼리에서만 읽는다 — 쿼리가 없으면 클릭 보고가 전부 누락된다
    const [defaultUrl] = env.swRegister.mock.calls[0];
    expect(defaultUrl.startsWith("/notikit-sw.js?")).toBe(true);
    const defaultQ = new URLSearchParams(defaultUrl.slice(defaultUrl.indexOf("?") + 1));
    expect(defaultQ.get("base")).toBe(base.baseUrl);
    expect(defaultQ.get("key")).toBe(base.apiKey);
    // 이게 빠지면 워커가 Firebase 를 초기화하지 못해 알림을 아예 못 받는다
    expect(defaultQ.get("fb_appId")).toBe(base.firebase.appId);
    expect(defaultQ.get("fb_senderId")).toBe(base.firebase.messagingSenderId);
  });

  it("registers the configured service worker path", async () => {
    const env = installBrowserEnv();
    const notikit = new NotikitWeb({ ...base, serviceWorkerPath: "/sw/custom.js", fetch: okFetch() });

    await notikit.register();

    const [customUrl] = env.swRegister.mock.calls[0];
    expect(customUrl.startsWith("/sw/custom.js?")).toBe(true);
    expect(new URLSearchParams(customUrl.slice(customUrl.indexOf("?") + 1)).get("key")).toBe(base.apiKey);
  });

  it("설정이 바뀌면 옛 워커를 벗겨내고 다시 등록한다", async () => {
    // 워커 본문은 버전당 바이트가 같아 브라우저가 새로 설치하지 않는다.
    // 벗겨내지 않으면 최초 설치 때의 api-key 를 계속 쓴다.
    const env = installBrowserEnv({ existingScriptURL: "https://site.test/notikit-sw.js?base=https%3A%2F%2Fpush.test&key=nk_OLD" });
    await new NotikitWeb({ ...base, fetch: okFetch() }).register();
    expect(env.unregister).toHaveBeenCalled();
  });

  it("설정이 같으면 그대로 둔다", async () => {
    const url = new URLSearchParams({
      base: base.baseUrl, key: base.apiKey,
      fb_apiKey: base.firebase.apiKey, fb_projectId: base.firebase.projectId,
      fb_senderId: base.firebase.messagingSenderId, fb_appId: base.firebase.appId,
    });
    const env = installBrowserEnv({ existingScriptURL: `https://site.test/notikit-sw.js?${url}` });
    await new NotikitWeb({ ...base, fetch: okFetch() }).register();
    expect(env.unregister).not.toHaveBeenCalled();
  });

  it("다른 경로의 워커는 건드리지 않는다", async () => {
    // 앱이 쓰는 워커를 지우면 안 된다
    const env = installBrowserEnv({ existingScriptURL: "https://site.test/app-sw.js?key=whatever" });
    await new NotikitWeb({ ...base, fetch: okFetch() }).register();
    expect(env.unregister).not.toHaveBeenCalled();
  });

  it("throws and skips device registration when permission is denied", async () => {
    installBrowserEnv({ permission: "denied" });
    const fetch = okFetch();
    const notikit = new NotikitWeb({ ...base, fetch });

    await expect(notikit.register()).rejects.toThrow("Notification permission denied");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the FCM registration token as a web device", async () => {
    installBrowserEnv();
    const fetch = okFetch();
    const notikit = new NotikitWeb({ ...base, externalId: "u1", identityHash: "h1", fetch });

    const token = await notikit.register();

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/devices");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      platform: "web",
      external_id: "u1",
      identity_hash: "h1",
      locale: "ko-KR",
    });
    expect(body.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // 서버는 이 값을 그대로 FCM 에 넘긴다 — 구독 JSON 이면 발송이 전부 실패한다
    expect(body.token).toBe(FCM_TOKEN);
    expect(token).toBe(FCM_TOKEN);
  });

  it("never sends the api-secret header from the browser", async () => {
    installBrowserEnv();
    const fetch = okFetch();
    const notikit = new NotikitWeb({ ...base, fetch });

    await notikit.register();

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers["api-key"]).toBe("nk_test");
    expect(init.headers["api-secret"]).toBeUndefined();
  });
});

describe("NotikitWeb.identify", () => {
  it("posts external_id, identityHash and attributes to the identify endpoint", async () => {
    installBrowserEnv();
    const fetch = mockFetch({ success: true, data: { user: { id: "u1" } }, error: null });
    const notikit = new NotikitWeb({ ...base, identityHash: "h1", fetch });

    await notikit.identify("u1", { plan: "pro" });

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/users/identify");
    expect(JSON.parse(init.body)).toMatchObject({
      external_id: "u1",
      identity_hash: "h1",
      attributes: { plan: "pro" },
      locale: "ko-KR",
    });
  });

  it("surfaces server failures as NotikitError", async () => {
    installBrowserEnv();
    const fetch = mockFetch({ success: false, data: null, error: "Invalid api key" }, false, 401);
    const notikit = new NotikitWeb({ ...base, fetch });

    await expect(notikit.identify("u1")).rejects.toBeInstanceOf(NotikitError);
  });
});

describe("NotikitWeb.core", () => {
  it("exposes the underlying core client for advanced calls", () => {
    const notikit = new NotikitWeb({ ...base, fetch: okFetch() });

    expect(notikit.core).toBeInstanceOf(NotikitClient);
  });
});
