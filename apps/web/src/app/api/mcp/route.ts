import { clientIp } from "@/lib/client-ip";
import { handleMcpMessage, type JsonRpcRequest, type JsonRpcResponse } from "@/lib/mcp-server";
import { bearerToken, resolveProjectByMcpToken } from "@/lib/mcp-token";
import { clientKey, rateLimitShared } from "@/lib/rate-limit";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";

export const dynamic = "force-dynamic";

const JSON_HEADERS = { "content-type": "application/json" };

function rpcFail(status: number, code: number, message: string, headers?: Record<string, string>) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** 연동 코드에 넣을 공개 주소. APP_ORIGIN 이 없으면 프록시가 넘긴 헤더로 추정한다. */
function publicBaseUrl(req: Request): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

/**
 * MCP 엔드포인트 (Streamable HTTP, 무상태).
 *
 * AI 도구가 `Authorization: Bearer <프로젝트 MCP 토큰>` 으로 직접 붙는다. 브라우저가 아니므로
 * Origin 검사 대신 토큰이 곧 인증이다 — 쿠키를 읽지 않아 CSRF 로 태울 것이 없다.
 */
export async function POST(req: Request) {
  // 토큰 대입 시도를 주소별로 묶는다. 토큰이 맞아도 세는 이유: 틀린 것만 세면 "한도 직전까지 틀리고
  // 한 번 맞히기"가 공짜가 된다.
  const ip = clientIp(req)?.ip ?? "unknown";
  if (!(await rateLimitShared(`mcp:ip:${ip}`, 300))) return rpcFail(429, -32000, "Rate limit exceeded");

  const project = bearerToken(req) ? await resolveProjectByMcpToken(req) : null;
  if (!project) {
    return rpcFail(401, -32001, "Unauthorized: issue an MCP token in the project's MCP page", {
      "www-authenticate": 'Bearer realm="notikit-mcp"',
    });
  }
  if (!(await rateLimitShared(clientKey(project.id, "mcp"), 300))) return rpcFail(429, -32000, "Rate limit exceeded");

  let payload: unknown;
  try {
    payload = await readJsonLimited(req, 64_000);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? rpcFail(413, -32600, "Payload too large") : rpcFail(400, -32700, "Parse error");
  }

  const ctx = { project, baseUrl: publicBaseUrl(req) };
  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as JsonRpcRequest[];
  if (messages.length === 0 || messages.length > 20) return rpcFail(400, -32600, "Invalid Request");

  const responses: JsonRpcResponse[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    const res = await handleMcpMessage(msg, ctx);
    if (res) responses.push(res);
  }

  // 알림만 온 요청에는 본문이 없다
  if (responses.length === 0) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(batch ? responses : responses[0]), { status: 200, headers: JSON_HEADERS });
}

/** 서버가 먼저 보내는 스트림(SSE)은 열지 않는다 — 규격대로 405 로 알린다 */
function methodNotAllowed() {
  return rpcFail(405, -32000, "Method not allowed", { allow: "POST" });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
