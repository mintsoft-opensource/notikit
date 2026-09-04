/** Notikit API — OpenAPI 3.1 (App SDK + Web Admin 두 그룹). SDK·문서·MCP 파생의 단일 소스. */
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Notikit API",
    version: "1.0.0",
    description:
      "유저 중심 푸시 API.\n\n- **App SDK**: 앱(모바일/웹)이 호출 — 헤더 `api-key` + `api-secret` (둘 다 필수)\n- **Web Admin**: 대시보드/관리자가 호출 — 헤더 `x-admin-token`",
  },
  servers: [{ url: "/", description: "current host" }],
  tags: [
    { name: "App SDK", description: "앱에서 요청하는 API (디바이스/유저/토픽/발송)" },
    { name: "Web Admin", description: "웹(대시보드)에서 요청하는 API (프로젝트 관리 등)" },
  ],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "api-key" },
      apiSecret: { type: "apiKey", in: "header", name: "api-secret" },
      adminToken: { type: "apiKey", in: "header", name: "x-admin-token" },
    },
  },
  paths: {
    // ─────────── App SDK ───────────
    "/api/v1/devices": {
      post: {
        tags: ["App SDK"],
        summary: "디바이스/토큰 등록·업서트",
        security: [{ apiKey: [], apiSecret: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token", "platform"],
                properties: {
                  token: { type: "string" },
                  platform: {
                    type: "string",
                    enum: ["android", "ios", "web", "webview", "electron", "flutter", "react-native"],
                  },
                  external_id: { type: "string", description: "고객 유저 ID (identity)" },
                  identity_hash: { type: "string", description: "HMAC-SHA256(external_id, api_secret) — external_id 바인딩 검증" },
                  app_version: { type: "string" },
                  os_version: { type: "string" },
                  locale: { type: "string", example: "ko-KR" },
                  timezone: { type: "string", example: "Asia/Seoul" },
                  country: { type: "string", example: "KR" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "등록됨" }, "401": { description: "인증 실패" } },
      },
    },
    "/api/v1/users/identify": {
      post: {
        tags: ["App SDK"],
        summary: "유저 식별 (identity)",
        security: [{ apiKey: [], apiSecret: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["external_id"],
                properties: {
                  external_id: { type: "string" },
                  identity_hash: { type: "string", description: "HMAC-SHA256(external_id, api_secret)" },
                  attributes: { type: "object", additionalProperties: true },
                  locale: { type: "string" },
                  timezone: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "식별됨" } },
      },
    },
    "/api/v1/topics/subscribe": {
      post: {
        tags: ["App SDK"],
        summary: "토픽 구독",
        security: [{ apiKey: [], apiSecret: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topic", "token"],
                properties: { topic: { type: "string" }, token: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "구독됨" }, "404": { description: "디바이스 없음" } },
      },
    },
    "/api/v1/messages": {
      post: {
        tags: ["App SDK"],
        summary: "푸시 전송 (큐잉)",
        security: [{ apiKey: [], apiSecret: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "body", "type"],
                properties: {
                  title: { type: "string", maxLength: 255 },
                  body: { type: "string" },
                  type: { type: "string", enum: ["single", "broadcast", "topic"] },
                  target: { type: "string" },
                  deep_link: { type: "string", format: "uri" },
                  data: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: { "202": { description: "큐잉됨" }, "422": { description: "검증 실패" } },
      },
    },
    "/api/health": {
      get: { tags: ["App SDK"], summary: "헬스체크", security: [], responses: { "200": { description: "ok" } } },
    },

    // ─────────── Web Admin ───────────
    "/api/admin/projects": {
      get: {
        tags: ["Web Admin"],
        summary: "프로젝트 목록",
        security: [{ adminToken: [] }],
        responses: { "200": { description: "목록" }, "401": { description: "인증 실패" } },
      },
      post: {
        tags: ["Web Admin"],
        summary: "프로젝트 생성 (api-key/secret 발급)",
        security: [{ adminToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  org_id: { type: "string", format: "uuid" },
                  environment: { type: "string", enum: ["dev", "staging", "production"] },
                },
              },
            },
          },
        },
        responses: { "201": { description: "생성됨" } },
      },
    },
  },
} as const;
