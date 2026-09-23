// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NotikitProvider, useNotikit, usePushRegistration } from "./index";
import { NotikitWeb } from "@notikit/web-sdk";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const config = { baseUrl: "https://push.test", apiKey: "nk_test", vapidPublicKey: "BArandom" };

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderHook<T>(useHook: () => T, withProvider = true, cfg = config) {
  const result: { current: T | null } = { current: null };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const tree = withProvider ? (
    <NotikitProvider config={cfg}>
      <Probe />
    </NotikitProvider>
  ) : (
    <Probe />
  );
  await React.act(async () => root.render(tree));
  return {
    result,
    rerender: (nextCfg: typeof config) =>
      React.act(async () =>
        root.render(
          <NotikitProvider config={nextCfg}>
            <Probe />
          </NotikitProvider>
        )
      ),
  };
}

describe("useNotikit", () => {
  it("returns a NotikitWeb instance inside the provider", async () => {
    const { result } = await renderHook(() => useNotikit());
    expect(result.current).toBeInstanceOf(NotikitWeb);
  });

  it("throws when used outside <NotikitProvider>", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderHook(() => useNotikit(), false)).rejects.toThrow(
      "useNotikit must be used within <NotikitProvider>"
    );
  });

  it("keeps the same instance across re-renders with an equivalent config", async () => {
    const { result, rerender } = await renderHook(() => useNotikit());
    const first = result.current;
    await rerender({ ...config });
    expect(result.current).toBe(first);
  });

  it("creates a new instance when a key config value changes", async () => {
    const { result, rerender } = await renderHook(() => useNotikit());
    const first = result.current;
    await rerender({ ...config, apiKey: "nk_other" });
    expect(result.current).not.toBe(first);
  });

  it("creates a new instance when userId changes", async () => {
    const { result, rerender } = await renderHook(() => useNotikit());
    const first = result.current;
    await rerender({ ...config, userId: "u1" } as typeof config);
    expect(result.current).not.toBe(first);
  });
});

describe("usePushRegistration", () => {
  it("starts as unsupported when Web Push is unavailable", async () => {
    vi.spyOn(NotikitWeb, "isSupported").mockReturnValue(false);
    const { result } = await renderHook(() => usePushRegistration());
    expect(result.current?.status).toBe("unsupported");
    expect(result.current?.token).toBeNull();
  });

  it("starts as idle when supported", async () => {
    vi.spyOn(NotikitWeb, "isSupported").mockReturnValue(true);
    const { result } = await renderHook(() => usePushRegistration());
    expect(result.current?.status).toBe("idle");
  });

  it("register success → registered with token", async () => {
    vi.spyOn(NotikitWeb, "isSupported").mockReturnValue(true);
    vi.spyOn(NotikitWeb.prototype, "register").mockResolvedValue("endpoint-token");
    const { result } = await renderHook(() => usePushRegistration());

    await React.act(async () => result.current!.register());

    expect(result.current?.status).toBe("registered");
    expect(result.current?.token).toBe("endpoint-token");
    expect(result.current?.error).toBeNull();
  });

  it("register failure → error status with message", async () => {
    vi.spyOn(NotikitWeb, "isSupported").mockReturnValue(true);
    vi.spyOn(NotikitWeb.prototype, "register").mockRejectedValue(new Error("Notification permission denied"));
    const { result } = await renderHook(() => usePushRegistration());

    await React.act(async () => result.current!.register());

    expect(result.current?.status).toBe("error");
    expect(result.current?.error).toBe("Notification permission denied");
    expect(result.current?.token).toBeNull();
  });
});
