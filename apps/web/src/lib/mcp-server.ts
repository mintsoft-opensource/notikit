import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, type Project } from "@/db/schema";
import { enqueuePush, messageDto, messageSchema, prepareMessage } from "@/lib/messages";
import { integrationSnippet } from "@/lib/mcp-snippets";
import { openapi } from "@/lib/openapi";
import { clientKey, rateLimitShared } from "@/lib/rate-limit";
import { CURRENT_VERSION } from "@/lib/updates";

/**
 * 서버에 내장한 MCP 엔드포인트의 본체 — Streamable HTTP 의 무상태(JSON 응답) 형태.
 *
 * SDK 의 전송 계층을 쓰지 않고 JSON-RPC 를 직접 받는다. 도구 다섯 개를 내는 데 필요한 것은
 * initialize · tools/list · tools/call 셋뿐이고, 세션·SSE 를 열지 않으면 요청마다 끝나서
 * 여러 web 인스턴스 어디로 가도 같은 답이 나온다.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const PLATFORMS = ["web", "react", "react-native", "flutter", "android", "swift"] as const;

type JsonRpcId = string | number | null;
export type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

export type McpContext = { project: Project; baseUrl: string };

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
};

/** 도구 실행 실패 — 프로토콜 오류가 아니라 `isError` 결과로 돌려준다(모델이 읽고 고칠 수 있게) */
class ToolError extends Error {}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export const MCP_TOOLS: Tool[] = [
  {
    name: "get_project",
    description: "이 토큰이 연결된 Notikit 프로젝트 정보 — 이름, 환경, api-key, 서버 주소, Firebase 설정 여부.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_args, { project, baseUrl }) => ({
      id: project.id,
      name: project.name,
      environment: project.environment,
      api_key: project.apiKey,
      base_url: baseUrl,
      // Firebase 가 없으면 발송은 받아들여지지만 실제로는 나가지 않는다(log-only)
      firebase_configured: !!project.firebaseCredentialsEnc,
    }),
  },
  {
    name: "get_integration_snippet",
    description: "플랫폼별 SDK 연동 코드. 서버 주소와 api-key 가 채워져 나오므로 그대로 앱에 넣는다.",
    inputSchema: {
      type: "object",
      properties: { platform: { type: "string", enum: [...PLATFORMS] } },
      required: ["platform"],
      additionalProperties: false,
    },
    run: async (args, { project, baseUrl }) => {
      const platform = str(args.platform);
      if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) {
        throw new ToolError(`platform must be one of: ${PLATFORMS.join(", ")}`);
      }
      return integrationSnippet(platform, baseUrl, project.apiKey);
    },
  },
  {
    name: "send_test_push",
    description:
      "유저 한 명에게 테스트 푸시를 보낸다. target 은 기기 토큰이 아니라 기기를 등록할 때 넘긴 user_id 다. 테스트로 표시되어 통계에서 빠지고 방해금지 시간대를 적용받지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "user_id" },
        title: { type: "string" },
        body: { type: "string" },
        deep_link: { type: "string", description: "알림을 눌렀을 때 열 주소 (선택)" },
      },
      required: ["target", "title", "body"],
      additionalProperties: false,
    },
    run: async (args, { project }) => {
      // 발송 API 와 같은 한도를 나눠 쓴다 — MCP 가 한도를 우회하는 길이 되면 안 된다
      if (!(await rateLimitShared(clientKey(project.id, "send")))) throw new ToolError("Rate limit exceeded");
      const parsed = messageSchema.safeParse({
        type: "single",
        target: args.target,
        title: args.title,
        body: args.body,
        deep_link: str(args.deep_link),
        test: true,
      });
      if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const prepared = await prepareMessage(project.id, parsed.data);
      if ("error" in prepared) throw new ToolError(prepared.error);
      const { message } = await enqueuePush(project, prepared.message, { sentBy: "mcp" });
      return {
        message: messageDto(message),
        note: project.firebaseCredentialsEnc
          ? "Queued. Check delivery with list_recent_sends."
          : "Queued, but Firebase is not configured for this project — the send is only logged, nothing reaches a device.",
      };
    },
  },
  {
    name: "list_recent_sends",
    description: "최근 발송 기록 — 상태와 성공·실패 수. 방금 보낸 테스트가 실제로 나갔는지 확인할 때 쓴다.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20, description: "기본 5" } },
      additionalProperties: false,
    },
    run: async (args, { project }) => {
      const n = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 20) : 5;
      const rows = await getDb()
        .select({
          id: pushLogs.id,
          type: pushLogs.type,
          target: pushLogs.target,
          title: pushLogs.title,
          status: pushLogs.status,
          failureReason: pushLogs.failureReason,
          totalCount: pushLogs.totalCount,
          successCount: pushLogs.successCount,
          failureCount: pushLogs.failureCount,
          createdAt: pushLogs.createdAt,
        })
        .from(pushLogs)
        .where(eq(pushLogs.projectId, project.id))
        .orderBy(desc(pushLogs.createdAt))
        .limit(n);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        target: r.target,
        title: r.title,
        status: r.status,
        failure_reason: r.failureReason,
        total: r.totalCount,
        success: r.successCount,
        failure: r.failureCount,
        created_at: r.createdAt.toISOString(),
      }));
    },
  },
  {
    name: "get_openapi",
    description: "Notikit OpenAPI 스펙. API 를 추측하지 말고 이 스펙을 근거로 삼는다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => openapi,
  },
];

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * JSON-RPC 메시지 하나를 처리한다. 알림(id 없음)은 답이 없으므로 null 을 돌려준다.
 */
export async function handleMcpMessage(msg: JsonRpcRequest, ctx: McpContext): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  }
  if (isNotification) return null;

  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize": {
      const asked = str(params.protocolVersion);
      const version = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked ?? "") ? asked! : MCP_PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "notikit", version: CURRENT_VERSION },
        instructions: `Notikit push project "${ctx.project.name}". Call get_project first to see whether Firebase is configured.`,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      try {
        return result(id, toolText(await tool.run(args, ctx)));
      } catch (e) {
        if (e instanceof ToolError) return result(id, toolText(e.message, true));
        throw e;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}
