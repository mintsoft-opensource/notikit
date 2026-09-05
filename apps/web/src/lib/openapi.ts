/** Notikit API — OpenAPI 3.1 (App SDK + Web Admin 두 그룹). SDK·문서·MCP 파생의 단일 소스. */
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Notikit API",
    version: "1.0.0",
    description:
      "유저 중심 푸시 API.\n\n- **App SDK (공개)**: 등록/식별/구독은 `api-key` 만으로 호출(클라이언트 안전). external_id 바인딩엔 `identity_hash` 필요.\n- **App SDK (발송)**: `POST /messages` 는 `api-key` + `api-secret` 필수(서버 전용).\n- **Web Admin**: `x-admin-token`.",
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
        security: [{ apiKey: [] }],
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
        security: [{ apiKey: [] }],
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
        security: [{ apiKey: [] }],
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
                  body: { type: "string", maxLength: 4000 },
                  type: {
                    type: "string",
                    enum: ["single", "broadcast", "topic", "segment"],
                    description: "single/topic/segment 는 target 필수, broadcast 는 전체 발송",
                  },
                  target: { type: "string", maxLength: 255, description: "external_id(single)/topic 이름/segment 이름" },
                  scheduled_at: { type: "string", format: "date-time", description: "예약 발송 시각(ISO8601). 미지정 시 방해금지 시간대 규칙 적용" },
                  deep_link: { type: "string", format: "uri", maxLength: 2048 },
                  data: { type: "object", additionalProperties: true, description: "커스텀 데이터 페이로드(최대 8KB)" },
                  variants: {
                    type: "array",
                    minItems: 2,
                    maxItems: 5,
                    description: "A/B 테스트 변형(제목/본문). 디바이스별 해시 분배",
                    items: {
                      type: "object",
                      required: ["title", "body"],
                      properties: { title: { type: "string", maxLength: 255 }, body: { type: "string", maxLength: 4000 } },
                    },
                  },
                  kakao_fallback: { type: "boolean", description: "미도달 유저에게 카카오 알림톡 대체 발송" },
                },
              },
            },
          },
        },
        responses: { "202": { description: "큐잉됨 (worker 가 실제 발송)" }, "413": { description: "페이로드 초과" }, "422": { description: "검증 실패" }, "429": { description: "rate limit" } },
      },
    },
    "/api/v1/suppressions": {
      post: {
        tags: ["App SDK"],
        summary: "수신 거부(opt-out) 등록",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "external_id 또는 token 중 하나 필수",
                properties: {
                  external_id: { type: "string", maxLength: 255 },
                  token: { type: "string", maxLength: 4096 },
                  reason: { type: "string", enum: ["opt_out", "bounced", "complaint", "manual"], default: "opt_out" },
                  identity_hash: { type: "string", description: "external_id 지정 시 필요" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "등록됨" }, "422": { description: "external_id 또는 token 필요" } },
      },
    },
    "/api/v1/inbox": {
      get: {
        tags: ["App SDK"],
        summary: "인앱 인박스 조회 (유저별 알림 목록)",
        security: [{ apiKey: [] }],
        parameters: [
          { name: "external_id", in: "query", required: true, schema: { type: "string" } },
          { name: "identity_hash", in: "query", required: false, schema: { type: "string" }, description: "identity 검증" },
        ],
        responses: { "200": { description: "최근 50건" }, "422": { description: "external_id 필요" } },
      },
    },
    "/api/v1/inbox/read": {
      post: {
        tags: ["App SDK"],
        summary: "인박스 읽음 처리",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["external_id"],
                properties: {
                  external_id: { type: "string", maxLength: 255 },
                  identity_hash: { type: "string", maxLength: 128 },
                  notification_id: { type: "string", format: "uuid", description: "미지정 시 전체 읽음 처리" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "읽음 처리됨" } },
      },
    },
    "/api/v1/journeys/enroll": {
      post: {
        tags: ["App SDK"],
        summary: "저니(워크플로) 등록",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["journey", "external_id"],
                properties: {
                  journey: { type: "string", minLength: 1, maxLength: 120, description: "저니 이름" },
                  external_id: { type: "string", minLength: 1, maxLength: 255 },
                  identity_hash: { type: "string", maxLength: 128 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "등록됨 (중복 무시)" }, "404": { description: "저니 없음" } },
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
    "/api/admin/projects/{id}": {
      patch: {
        tags: ["Web Admin"],
        summary: "프로젝트 설정 변경 (identity 검증/방해금지 시간대)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  require_identity_verification: { type: "boolean" },
                  quiet_start_hour: { type: "integer", minimum: 0, maximum: 23, nullable: true },
                  quiet_end_hour: { type: "integer", minimum: 0, maximum: 23, nullable: true },
                },
              },
            },
          },
        },
        responses: { "200": { description: "변경됨" }, "404": { description: "프로젝트 없음" } },
      },
    },
    "/api/admin/projects/{id}/logs": {
      get: {
        tags: ["Web Admin"],
        summary: "발송 로그 조회 (최근 50건)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "로그 목록" } },
      },
    },
    "/api/admin/projects/{id}/stats": {
      get: {
        tags: ["Web Admin"],
        summary: "분석 통계 (DAU/디바이스/발송 집계)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "통계" } },
      },
    },
    "/api/admin/projects/{id}/kakao": {
      post: {
        tags: ["Web Admin"],
        summary: "카카오 알림톡 설정 업로드 — 검증 후 암호화 저장",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider_url", "api_key", "sender_key"],
                properties: {
                  provider_url: { type: "string", format: "uri" },
                  api_key: { type: "string" },
                  sender_key: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "저장됨" }, "422": { description: "유효하지 않은 설정" } },
      },
    },
    "/api/admin/projects/{id}/segments": {
      get: {
        tags: ["Web Admin"],
        summary: "세그먼트 목록",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "목록" } },
      },
      post: {
        tags: ["Web Admin"],
        summary: "세그먼트 생성 (속성 매칭 규칙)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 120 },
                  rules: {
                    type: "array",
                    maxItems: 20,
                    items: {
                      type: "object",
                      required: ["attribute", "value"],
                      properties: { attribute: { type: "string", maxLength: 64 }, value: { type: "string", maxLength: 255 } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "201": { description: "생성됨" } },
      },
    },
    "/api/admin/projects/{id}/webhooks": {
      get: {
        tags: ["Web Admin"],
        summary: "웹훅 목록",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "목록" } },
      },
      post: {
        tags: ["Web Admin"],
        summary: "웹훅 등록 (HMAC 서명 배송, SSRF 방어)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", format: "uri", maxLength: 2048 },
                  events: { type: "array", maxItems: 30, items: { type: "string", maxLength: 64 }, description: "빈 배열이면 전체 이벤트 구독" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "생성됨 (secret 반환)" }, "422": { description: "차단된 URL(SSRF)" } },
      },
    },
    "/api/admin/projects/{id}/webhooks/retry": {
      post: {
        tags: ["Web Admin"],
        summary: "실패 웹훅 재시도 — worker/cron",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "{ retried }" } },
      },
    },
    "/api/admin/projects/{id}/journeys": {
      get: {
        tags: ["Web Admin"],
        summary: "저니 목록",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "목록" } },
      },
      post: {
        tags: ["Web Admin"],
        summary: "저니(워크플로) 생성 (send/wait 스텝)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "steps"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 120 },
                  steps: {
                    type: "array",
                    minItems: 1,
                    maxItems: 30,
                    items: {
                      type: "object",
                      required: ["type"],
                      properties: {
                        type: { type: "string", enum: ["send", "wait"] },
                        title: { type: "string", maxLength: 255 },
                        body: { type: "string", maxLength: 4000 },
                        hours: { type: "integer", minimum: 0, description: "wait 스텝 대기 시간" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "201": { description: "생성됨" } },
      },
    },
    "/api/admin/projects/{id}/journeys/process": {
      post: {
        tags: ["Web Admin"],
        summary: "저니 실행 진행 — worker/cron",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "{ processed }" } },
      },
    },
    "/api/admin/projects/{id}/firebase": {
      post: {
        tags: ["Web Admin"],
        summary: "Firebase 서비스 계정 업로드 (웹) — 검증 후 암호화 저장",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  credentials: {
                    type: "object",
                    description: "Firebase 서비스 계정 JSON (type/project_id/private_key/client_email)",
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "저장됨" }, "422": { description: "유효하지 않은 서비스 계정" } },
      },
    },
    "/api/admin/projects/{id}/process-queue": {
      post: {
        tags: ["Web Admin"],
        summary: "큐잉된 푸시 처리(실제 FCM 발송) — worker/cron",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "{ processed, failed }" } },
      },
    },
  },
} as const;
