import { describe, expect, it } from "vitest";
import type { Project } from "@/db/schema";
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, MCP_TOOLS } from "./mcp-server";
import { bearerToken, generateMcpToken, hashMcpToken, MCP_TOKEN_PREFIX } from "./mcp-token";

const project = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "demo",
  environment: "production",
  apiKey: "nk_demo",
  firebaseCredentialsEnc: null,
} as unknown as Project;
const ctx = { project, baseUrl: "https://push.example.com" };

type Ok = { result: Record<string, unknown> };
type Err = { error: { code: number } };

describe("mcp-token", () => {
  it("토큰은 접두사가 붙고 매번 다르며, 저장하는 값은 원문이 아니다", () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashMcpToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken(a)).not.toContain(a.slice(MCP_TOKEN_PREFIX.length));
  });

  it("Authorization 헤더에서 Bearer 토큰만 꺼낸다", () => {
    const req = (v?: string) => new Request("http://x/api/mcp", { headers: v ? { authorization: v } : {} });
    expect(bearerToken(req("Bearer nkm_abc"))).toBe("nkm_abc");
    expect(bearerToken(req("bearer nkm_abc"))).toBe("nkm_abc");
    expect(bearerToken(req("Basic abc"))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
});

describe("handleMcpMessage", () => {
  it("initialize: 지원하는 버전은 그대로, 모르는 버전은 최신으로 답한다", async () => {
    const known = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      ctx
    )) as Ok;
    expect(known.result.protocolVersion).toBe("2024-11-05");
    expect(known.result.capabilities).toEqual({ tools: {} });

    const unknown = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      ctx
    )) as Ok;
    expect(unknown.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it("알림(id 없음)에는 답하지 않는다", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
  });

  it("tools/list: 프로젝트 범위 도구만 내고, 프로젝트를 만들거나 나열하는 도구는 없다", async () => {
    const res = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx)) as Ok;
    const names = (res.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(names).not.toContain("create_project");
    expect(names).not.toContain("list_projects");
  });

  it("get_project: 토큰의 프로젝트와 공개 주소를 돌려준다", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_project", arguments: {} } },
      ctx
    )) as Ok;
    const body = JSON.parse((res.result.content as { text: string }[])[0].text);
    expect(body).toMatchObject({ id: project.id, api_key: "nk_demo", base_url: ctx.baseUrl, firebase_configured: false });
  });

  it("get_integration_snippet: 서버 주소와 api-key 가 채워진다 · 모르는 플랫폼은 isError", async () => {
    const good = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_integration_snippet", arguments: { platform: "flutter" } } },
      ctx
    )) as Ok;
    const text = (good.result.content as { text: string }[])[0].text;
    expect(text).toContain("https://push.example.com");
    expect(text).toContain("nk_demo");

    const bad = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_integration_snippet", arguments: { platform: "cobol" } } },
      ctx
    )) as Ok;
    expect(bad.result.isError).toBe(true);
  });

  it("모르는 도구·메서드·잘못된 요청은 JSON-RPC 오류다", async () => {
    const tool = (await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } }, ctx)) as Err;
    expect(tool.error.code).toBe(-32602);
    const method = (await handleMcpMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, ctx)) as Err;
    expect(method.error.code).toBe(-32601);
    const invalid = (await handleMcpMessage({ id: 9, method: "ping" }, ctx)) as Err;
    expect(invalid.error.code).toBe(-32600);
  });
});
