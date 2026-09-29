import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/license", () => ({ canReceiveUpdates: () => true }));

const DIGEST = `sha256:${"a".repeat(64)}`;

async function load() {
  vi.resetModules();
  vi.stubEnv("NOTIKIT_UPDATE_SERVER", "https://updates.example.com");
  vi.stubEnv("NOTIKIT_LICENSE_KEY", "nk1.test.sig");
  vi.stubEnv("NOTIKIT_VERSION", "1.0.0");
  return import("@/lib/updates");
}

function respond(res: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

describe("checkForUpdate", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("배포처가 {latest:null} 이면 '최신' 이다 — 채널에 릴리스가 없거나 배포가 멈춘 고객", async () => {
    respond(new Response(JSON.stringify({ latest: null }), { status: 200 }));
    const { checkForUpdate } = await load();
    const r = await checkForUpdate({ force: true });
    expect(r).toMatchObject({ status: "ok", latest: null, outdated: false, blockedBy: null });
  });

  it("예전 배포처의 204 도 '최신' 으로 읽는다 — '연결 불가' 가 아니다", async () => {
    respond(new Response(null, { status: 204 }));
    const { checkForUpdate } = await load();
    const r = await checkForUpdate({ force: true });
    expect(r).toMatchObject({ status: "ok", latest: null, outdated: false });
  });

  it("릴리스가 오면 그대로 쓴다", async () => {
    respond(
      new Response(
        JSON.stringify({ version: "1.1.0", image: "ghcr.io/acme/notikit", digest: DIGEST, hasMigrations: true }),
        { status: 200 }
      )
    );
    const { checkForUpdate } = await load();
    const r = await checkForUpdate({ force: true });
    expect(r.status).toBe("ok");
    expect(r.outdated).toBe(true);
    expect(r.latest?.hasMigrations).toBe(true);
  });

  it("모양이 어긋난 응답은 여전히 '연결 불가'", async () => {
    respond(new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 }));
    const { checkForUpdate } = await load();
    expect((await checkForUpdate({ force: true })).status).toBe("unreachable");
  });
});
