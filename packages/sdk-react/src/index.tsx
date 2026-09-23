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
  // NotikitWeb 은 config 를 통째로 붙들고 호출 시점에 읽는다. 여기 빠진 필드는
  // 값이 바뀌어도 인스턴스가 재생성되지 않아 옛 값이 계속 쓰인다 — identityHash 가
  // 비동기로 늦게 도착하는 흔한 경우에 사칭 방지 해시가 영영 undefined 로 나간다.
  // 인스턴스는 상태가 없어 재생성 비용이 없으므로 읽는 필드를 모두 넣는다.
  const instance = React.useMemo(() => new NotikitWeb(config), [
    config.baseUrl,
    config.apiKey,
    config.vapidPublicKey,
    config.userId,
    config.externalId,
    config.identityHash,
    config.serviceWorkerPath,
    config.fetch,
    config.firebase,
    config.getToken,
    config.firebaseSdkVersion,
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
