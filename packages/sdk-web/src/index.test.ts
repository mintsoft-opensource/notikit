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

const base = {
  baseUrl: "https://push.test",
  apiKey: "nk_test",
  vapidPublicKey: "q_-A",
};

function installBrowserEnv({ permission = "granted" }: { permission?: string } = {}) {
  const subscription = { endpoint: "https://push.test/ep-1", keys: { p256dh: "p", auth: "a" } };
  const subscribe = vi.fn(async () => subscription);
  const registration = { pushManager: { subscribe } };
  const swRegister = vi.fn(async () => registration);
  const requestPermission = vi.fn(async () => permission);

  vi.stubGlobal("navigator", {
    language: "ko-KR",
    serviceWorker: { register: swRegister, ready: Promise.resolve(registration) },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { requestPermission });

  return { subscription, subscribe, swRegister, requestPermission };
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

    expect(env.swRegister).toHaveBeenCalledWith("/notikit-sw.js");
  });

  it("registers the configured service worker path", async () => {
    const env = installBrowserEnv();
    const notikit = new NotikitWeb({ ...base, serviceWorkerPath: "/sw/custom.js", fetch: okFetch() });

    await notikit.register();

    expect(env.swRegister).toHaveBeenCalledWith("/sw/custom.js");
  });

  it("throws and skips device registration when permission is denied", async () => {
    const env = installBrowserEnv({ permission: "denied" });
    const fetch = okFetch();
    const notikit = new NotikitWeb({ ...base, fetch });

    await expect(notikit.register()).rejects.toThrow("Notification permission denied");
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("subscribes with userVisibleOnly and the decoded VAPID key", async () => {
    const env = installBrowserEnv();
    const notikit = new NotikitWeb({ ...base, fetch: okFetch() });

    await notikit.register();

    const options = env.subscribe.mock.calls[0][0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey)).toEqual([0xab, 0xff, 0x80]);
  });

  it("decodes base64url VAPID keys that require padding", async () => {
    const env = installBrowserEnv();
    const notikit = new NotikitWeb({ ...base, vapidPublicKey: "AQ", fetch: okFetch() });

    await notikit.register();

    const options = env.subscribe.mock.calls[0][0] as { applicationServerKey: Uint8Array };
    expect(Array.from(options.applicationServerKey)).toEqual([0x01]);
  });

  it("posts the subscription as a web device and returns it as the token", async () => {
    const env = installBrowserEnv();
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
    expect(JSON.parse(token)).toEqual(env.subscription);
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
