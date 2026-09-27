import { describe, it, expect, vi } from "vitest";
import { NOTIKIT_SERVICE_WORKER, NOTIKIT_SW_MESSAGE_TYPE } from "./service-worker";

const BASE = "https://push.test";
const KEY = "nk_test";
const FCM_TOKEN = "fcm-token-1";
const SW_URL = `https://site.test/notikit-sw.js?base=${BASE}&key=${KEY}&fb_appId=1%3A1%3Aweb%3Aabc`;

type Handler = (event: unknown) => unknown;
type Payload = { data?: Record<string, string>; notification?: Record<string, string> };

/**
 * 워커 템플릿은 문자열로 배포되는 산출물이다 — 실제로 실행해 보지 않으면 검증할 방법이 없다.
 * 워커 전역(self·firebase·clients·indexedDB·fetch)을 넘겨 격리 실행한다.
 */
function runWorker({ token = FCM_TOKEN, windows = 1 }: { token?: string | null; windows?: number } = {}) {
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const listeners: Record<string, Handler> = {};
  const self = {
    location: { href: SW_URL },
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      }),
    },
    addEventListener: (type: string, fn: Handler) => {
      listeners[type] = fn;
    },
  };

  let onBackground: ((p: Payload) => unknown) | undefined;
  const firebase = {
    initializeApp: vi.fn(),
    messaging: () => ({ onBackgroundMessage: (fn: (p: Payload) => unknown) => (onBackground = fn) }),
  };

  const pages = Array.from({ length: windows }, () => ({ postMessage: vi.fn() }));
  const clients = {
    matchAll: vi.fn(async () => pages),
    openWindow: vi.fn(async () => null),
  };

  // 메인 스레드가 남긴 토큰 — 워커는 getToken 을 부를 수 없어 IndexedDB 로만 읽는다
  const indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {
        result: {
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const g: Record<string, unknown> = {};
                queueMicrotask(() => {
                  g.result = token;
                  (g.onsuccess as (() => void) | undefined)?.();
                });
                return g;
              },
            }),
          }),
          close: () => {},
        },
      };
      queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
      return req;
    },
  };

  const fetch = vi.fn(async () => new Response("{}"));

  new Function("self", "firebase", "importScripts", "clients", "indexedDB", "fetch", NOTIKIT_SERVICE_WORKER)(
    self,
    firebase,
    () => {},
    clients,
    indexedDB,
    fetch
  );

  return {
    shown,
    fetch,
    clients,
    pages,
    showNotification: self.registration.showNotification,
    receive: (payload: Payload) => onBackground?.(payload),
    /** push 이벤트 — 배달된 모든 메시지에 대해 한 번 뜬다(알림을 그리기 전). */
    async push(payload: Payload | string) {
      const waited: unknown[] = [];
      await listeners.push?.({
        data: typeof payload === "string" ? { json: () => JSON.parse(payload) } : { json: () => payload },
        waitUntil: (p: unknown) => waited.push(p),
      });
      await Promise.all(waited);
    },
    /** 알림 클릭. 직전에 그린 알림의 data 를 그대로 쓴다 — 워커가 실제로 받는 모양이다. */
    async click(action?: string) {
      const waited: unknown[] = [];
      const notification = shown[shown.length - 1];
      await listeners.notificationclick?.({
        action,
        notification: { data: notification?.options.data, close: vi.fn() },
        waitUntil: (p: unknown) => waited.push(p),
      });
      await Promise.all(waited);
    },
  };
}

const ACTIONS = JSON.stringify([
  { id: "buy", title: "결제하기", deep_link: "https://shop.test/cart" },
  { id: "later", title: "나중에" },
]);

describe("service worker: 무음 푸시", () => {
  it("제목·본문이 없는 발송은 알림을 띄우지 않고 열린 탭으로 넘긴다", async () => {
    // 서버는 options.silent 면 title/body 를 아예 싣지 않는다(fcm.buildMulticast).
    // 기본 제목으로 띄우면 무음 발송이 웹에서만 시끄러워진다.
    const w = runWorker();

    await w.receive({ data: { sync: "1", notikit_log_id: "L1" } });

    expect(w.showNotification).not.toHaveBeenCalled();
    expect(w.pages[0].postMessage).toHaveBeenCalledWith({
      type: NOTIKIT_SW_MESSAGE_TYPE,
      data: { sync: "1", notikit_log_id: "L1" },
    });
  });

  it("열린 탭이 없으면 조용히 끝난다 — 무음 푸시에 알림을 대신 띄우지 않는다", async () => {
    const w = runWorker({ windows: 0 });

    await w.receive({ data: { sync: "1" } });

    expect(w.showNotification).not.toHaveBeenCalled();
  });

  it("제목이 있으면 평소대로 알림을 띄운다", async () => {
    const w = runWorker();

    await w.receive({ data: { title: "주문 완료", body: "곧 출발합니다", deep_link: "/orders/1" } });

    expect(w.shown[0].title).toBe("주문 완료");
    expect(w.pages[0].postMessage).not.toHaveBeenCalled();
  });
});

describe("service worker: 액션 버튼", () => {
  it("data.actions 를 알림 액션으로 그린다", async () => {
    const w = runWorker();

    await w.receive({ data: { title: "장바구니", actions: ACTIONS } });

    expect(w.shown[0].options.actions).toEqual([
      { action: "buy", title: "결제하기" },
      { action: "later", title: "나중에" },
    ]);
  });

  it("모양이 틀린 액션은 버리고 3개까지만 싣는다", async () => {
    const w = runWorker();
    const raw = JSON.stringify([
      { id: "a", title: "A" },
      { id: "no-title" },
      { title: "no-id" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ]);

    await w.receive({ data: { title: "t", actions: raw } });

    // 반쪽짜리 버튼은 눌러도 어디로 갈지 알 수 없다 — 그리지 않는다
    expect(w.shown[0].options.actions).toEqual([
      { action: "a", title: "A" },
      { action: "b", title: "B" },
      { action: "c", title: "C" },
    ]);
  });

  it("actions 가 깨진 JSON 이면 알림 자체는 그대로 뜬다", async () => {
    const w = runWorker();

    await w.receive({ data: { title: "t", actions: "not json" } });

    expect(w.shown[0].title).toBe("t");
    expect(w.shown[0].options.actions).toBeUndefined();
  });
});

describe("service worker: 클릭", () => {
  it("액션 버튼을 누르면 그 버튼의 deep_link 로 가고 착지 주소로 클릭을 보고한다", async () => {
    const w = runWorker();
    await w.receive({ data: { title: "장바구니", actions: ACTIONS, deep_link: "/cart", notikit_log_id: "L1" } });

    await w.click("buy");

    expect(w.clients.openWindow).toHaveBeenCalledWith("https://shop.test/cart");
    const [url, init] = w.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/messages/click`);
    expect(JSON.parse(init.body as string)).toEqual({
      log_id: "L1",
      token: FCM_TOKEN,
      destination: "https://shop.test/cart",
    });
  });

  it("링크 없는 액션은 발송의 deep_link 로 떨어진다", async () => {
    const w = runWorker();
    await w.receive({ data: { title: "장바구니", actions: ACTIONS, deep_link: "/cart", notikit_log_id: "L1" } });

    await w.click("later");

    // 버튼을 눌렀는데 아무 데도 가지 않는 것보다 발송 링크로 가는 편이 낫다
    expect(w.clients.openWindow).toHaveBeenCalledWith("/cart");
  });

  it("알림 본문 클릭은 발송의 deep_link 로 간다", async () => {
    const w = runWorker();
    await w.receive({ data: { title: "장바구니", actions: ACTIONS, deep_link: "/cart", notikit_log_id: "L1" } });

    await w.click();

    expect(w.clients.openWindow).toHaveBeenCalledWith("/cart");
  });

  it("토큰이 없으면 보고하지 않되 화면 이동은 막지 않는다", async () => {
    const w = runWorker({ token: null });
    await w.receive({ data: { title: "t", deep_link: "/cart", notikit_log_id: "L1" } });

    await w.click();

    expect(w.clients.openWindow).toHaveBeenCalledWith("/cart");
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe("service worker: 수신 보고", () => {
  it("push 이벤트에서 수신을 보고한다", async () => {
    // 발송 성공(FCM 접수)은 기기가 꺼져 있어도 성공한다 — 도달은 단말만 말해 줄 수 있다
    const w = runWorker();
    await w.push({ data: { notikit_log_id: "log-1", title: "제목", body: "본문" } });

    const [url, init] = w.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/messages/received`);
    expect((init.headers as Record<string, string>)["api-key"]).toBe(KEY);
    expect(JSON.parse(String(init.body))).toEqual({ log_id: "log-1", token: FCM_TOKEN });
  });

  it("무음(data-only) 푸시도 도달로 센다", async () => {
    // onBackgroundMessage 에 보고를 달았다면 여기가 통째로 빠진다 — 무음 발송은 알림을
    // 그리지 않고, 열린 탭이 없으면 그 콜백이 하는 일도 없다.
    const w = runWorker({ windows: 0 });
    await w.push({ data: { notikit_log_id: "log-silent" } });
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((w.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).log_id).toBe("log-silent");
  });

  it("같은 발송이 다시 배달되면 요청을 내보내지 않는다", async () => {
    const w = runWorker();
    await w.push({ data: { notikit_log_id: "log-1" } });
    await w.push({ data: { notikit_log_id: "log-1" } });
    expect(w.fetch).toHaveBeenCalledTimes(1);

    await w.push({ data: { notikit_log_id: "log-2" } });
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("notikit 발송이 아니면 아무것도 보내지 않는다", async () => {
    const w = runWorker();
    await w.push({ data: { title: "남의 푸시" } });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("토큰이 없으면 보고하지 않는다", async () => {
    // 등록 때와 같은 토큰이어야 서버가 기기를 찾는다 — 없는 채로 보내면 404 만 쌓인다
    const w = runWorker({ token: null });
    await w.push({ data: { notikit_log_id: "log-1" } });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("JSON 이 아닌 payload 에서 터지지 않는다", async () => {
    const w = runWorker();
    await expect(w.push("not json")).resolves.toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
  });
});
