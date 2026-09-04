/** Notikit 공개 API — OpenAPI 3.1 스펙 (SDK·문서·MCP 파생의 단일 소스) */
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Notikit API",
    version: "1.0.0",
    description:
      "유저 중심(user-centric) 푸시 알림 API. 인증: 헤더 `api-key` + `api-secret` (또는 spring 호환 `X-Project-Id`/`X-Api-Key`).",
  },
  servers: [{ url: "/", description: "current host" }],
  security: [{ apiKey: [], apiSecret: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "api-key" },
      apiSecret: { type: "apiKey", in: "header", name: "api-secret" },
    },
    schemas: {
      Envelope: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: {},
          error: { type: "string", nullable: true },
        },
      },
    },
  },
  paths: {
    "/api/v1/devices": {
      post: {
        summary: "디바이스/토큰 등록·업서트",
        description: "FCM/APNs 토큰을 등록하고, external_id 가 있으면 유저에 연결(다중 기기).",
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
                  external_id: { type: "string", description: "고객 시스템 유저 ID (identity 연결)" },
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
        summary: "유저 식별 (identity)",
        description: "외부 유저 ID 를 업서트하고 속성(세그먼트용)을 저장.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["external_id"],
                properties: {
                  external_id: { type: "string" },
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
        summary: "토픽 구독",
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
        summary: "푸시 전송 (큐잉)",
        description: "수집 즉시 큐잉하고 202 반환. 실제 fan-out 은 worker 가 처리.",
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
                  target: { type: "string", description: "유저/디바이스/토픽 (broadcast 제외 필수)" },
                  deep_link: { type: "string", format: "uri", description: "탭 시 열 화면 URL" },
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
      get: { summary: "헬스체크", security: [], responses: { "200": { description: "ok" } } },
    },
  },
} as const;
