import * as React from "react";
import { NotikitWeb, type NotikitWebConfig } from "@notikit/web-sdk";

const Ctx = React.createContext<NotikitWeb | null>(null);

export function NotikitProvider({
  config,
  children,
}: {
  config: NotikitWebConfig;
  children: React.ReactNode;
}) {
  const instance = React.useMemo(() => new NotikitWeb(config), [
    config.baseUrl,
    config.apiKey,
    config.vapidPublicKey,
    config.externalId,
  ]);
  return <Ctx.Provider value={instance}>{children}</Ctx.Provider>;
}

export function useNotikit(): NotikitWeb {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useNotikit must be used within <NotikitProvider>");
  return v;
}

export type PushRegistrationState = {
  status: "idle" | "registering" | "registered" | "error" | "unsupported";
  token: string | null;
  error: string | null;
  register: () => Promise<void>;
};

/** 푸시 등록 훅 — 버튼에 연결해 권한 요청 + 구독 + 서버 등록 */
export function usePushRegistration(): PushRegistrationState {
  const notikit = useNotikit();
  const [status, setStatus] = React.useState<PushRegistrationState["status"]>(
    NotikitWeb.isSupported() ? "idle" : "unsupported"
  );
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const register = React.useCallback(async () => {
    setStatus("registering");
    setError(null);
    try {
      const t = await notikit.register();
      setToken(t);
      setStatus("registered");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [notikit]);

  return { status, token, error, register };
}

export * from "@notikit/core";
