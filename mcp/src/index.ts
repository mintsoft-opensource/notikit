#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { integrationSnippet } from "./snippets.js";

const BASE_URL = (process.env.NOTIKIT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.NOTIKIT_ADMIN_TOKEN ?? "";

async function api(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "notikit", version: "0.1.0" });

server.registerTool(
  "create_project",
  {
    description:
      "새 Notikit 프로젝트 생성 후 api-key/secret 발급 (Web Admin). org_id 를 주지 않으면 조직이 새로 만들어져 콘솔 계정에서는 보이지 않는다 — 콘솔에서 쓸 프로젝트면 list_projects 의 orgId 를 넘긴다.",
    inputSchema: {
      name: z.string().describe("프로젝트 이름"),
      org_id: z.string().uuid().optional().describe("프로젝트를 넣을 조직 ID (list_projects 의 orgId)"),
      environment: z.enum(["dev", "staging", "production"]).optional(),
    },
  },
  async ({ name, org_id, environment }) =>
    text(await api("/api/admin/projects", { method: "POST", headers: { "x-admin-token": ADMIN_TOKEN }, body: JSON.stringify({ name, org_id, environment }) }))
);

server.registerTool(
  "list_projects",
  { description: "프로젝트 목록 조회 (Web Admin).", inputSchema: {} },
  async () => text(await api("/api/admin/projects", { method: "GET", headers: { "x-admin-token": ADMIN_TOKEN } }))
);

server.registerTool(
  "get_integration_snippet",
  {
    description: "플랫폼별 SDK 통합 코드 스니펫 반환 (실제 api-key 채움). AI 가 그대로 앱에 삽입.",
    inputSchema: {
      platform: z.enum(["web", "react", "react-native", "flutter", "android", "swift"]),
      // 코드 삽입용이므로 형식 검증(따옴표 이스케이프/주입 방지)
      api_key: z.string().regex(/^nk_[A-Za-z0-9_-]{1,64}$/, "invalid api-key format").describe("프로젝트 api-key"),
    },
  },
  async ({ platform, api_key }) => text(integrationSnippet(platform, BASE_URL, api_key))
);

server.registerTool(
  "send_test_push",
  {
    description: "테스트 푸시 발송 (privileged — api-key + api-secret 필요).",
    inputSchema: {
      api_key: z.string(),
      api_secret: z.string(),
      target: z.string().describe("유저 external_id"),
      title: z.string(),
      body: z.string(),
      deep_link: z.string().url().optional(),
    },
  },
  async ({ api_key, api_secret, target, title, body, deep_link }) =>
    text(
      await api("/api/v1/messages", {
        method: "POST",
        headers: { "api-key": api_key, "api-secret": api_secret },
        body: JSON.stringify({ title, body, type: "single", target, deep_link }),
      })
    )
);

server.registerTool(
  "get_openapi",
  { description: "Notikit OpenAPI 스펙 반환 (API 근거).", inputSchema: {} },
  async () => text(await api("/api/openapi.json", { method: "GET" }))
);

await server.connect(new StdioServerTransport());
