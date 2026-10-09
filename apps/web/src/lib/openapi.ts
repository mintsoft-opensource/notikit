/** Notikit API — OpenAPI 3.1 (App SDK + Web Admin 두 그룹). SDK·문서·MCP 파생의 단일 소스. */
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Notikit API",
    version: "1.0.0",
    description:
      "유저 중심 푸시 API.\n\n- **App SDK (공개)**: 등록/식별/구독은 `api-key` 만으로 호출(클라이언트 안전). user_id 바인딩엔 `identity_hash` 필요. `user_id` 는 고객사 서비스의 회원 ID 이며, 예전 이름 `external_id` 도 모든 요청에서 똑같이 받는다.\n- **App SDK (발송)**: `POST /messages` 는 `api-key` + `api-secret` 필수(서버 전용).\n- **Web Admin**: `x-admin-token`.",
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
                  user_id: { type: "string", description: "고객 유저 ID (identity)" },
                  identity_hash: { type: "string", description: "HMAC-SHA256(user_id, api_secret) — user_id 바인딩 검증" },
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
                required: ["user_id"],
                properties: {
                  user_id: { type: "string" },
                  identity_hash: { type: "string", description: "HMAC-SHA256(user_id, api_secret)" },
                  name: { type: "string", maxLength: 100, nullable: true, description: "사용자 이름 — 치환 변수 {{name}}, 콘솔 표시·검색. null 이면 지운다" },
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
    "/api/v1/devices/rotate": {
      post: {
        tags: ["App SDK"],
        summary: "푸시 토큰 교체",
        description:
          "기존 기기 행의 토큰을 제자리 갱신한다. 새 토큰으로 재등록하면 행이 하나 더 생겨 같은 사람에게 중복 발송된다. 유저가 묶인 기기는 identity_hash 필요.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["old_token", "new_token"],
                properties: {
                  old_token: { type: "string" },
                  new_token: { type: "string" },
                  identity_hash: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "202": { description: "처리됨 (rotated=false 는 대상 없음/이미 등록됨)" },
          "403": { description: "identity_hash 누락·불일치" },
        },
      },
    },
    "/api/v1/topics/subscribe": {
      post: {
        tags: ["App SDK"],
        summary: "토픽 구독",
        description:
          "token 이면 그 기기 하나, user_id 면 그 사람의 활성 기기 전부. 둘 중 하나만 보낸다. " +
          "없는 그룹은 자동 생성된다. 규칙식 그룹은 명단이 자동으로 정해지므로 409.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topic"],
                properties: {
                  topic: { type: "string", minLength: 1, maxLength: 255 },
                  token: { type: "string", description: "기기 하나. user_id 와 배타." },
                  user_id: { type: "string", description: "그 사람의 활성 기기 전부. token 과 배타." },
                  identity_hash: { type: "string", description: "HMAC-SHA256(user_id, api_secret). user_id 를 보낼 때 필수." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "구독됨" },
          "403": { description: "user_id 에 identity_hash 누락·불일치" },
          "404": { description: "디바이스 또는 유저 없음" },
          "409": { description: "규칙식 그룹 — 구독으로 넣을 수 없음" },
          "422": { description: "token 과 user_id 중 정확히 하나가 필요" },
        },
      },
    },
    "/api/v1/topics/unsubscribe": {
      post: {
        tags: ["App SDK"],
        summary: "토픽 구독 해지",
        description:
          "subscribe 와 같은 본문. 구독과 달리 없는 그룹을 만들지 않는다 — 해지 요청으로 그룹이 생기면 안 된다.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topic"],
                properties: {
                  topic: { type: "string", minLength: 1, maxLength: 255 },
                  token: { type: "string", description: "기기 하나. user_id 와 배타." },
                  user_id: { type: "string", description: "그 사람의 활성 기기 전부. token 과 배타." },
                  identity_hash: { type: "string", description: "HMAC-SHA256(user_id, api_secret). user_id 를 보낼 때 필수." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "해지됨" },
          "403": { description: "user_id 에 identity_hash 누락·불일치" },
          "404": { description: "그룹·디바이스·유저 없음" },
          "409": { description: "규칙식 그룹 — 구독으로 뺄 수 없음" },
          "422": { description: "token 과 user_id 중 정확히 하나가 필요" },
        },
      },
    },
    "/api/v1/messages": {
      post: {
        tags: ["App SDK"],
        summary: "푸시 전송 (큐잉)",
        security: [{ apiKey: [], apiSecret: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 255 },
            description:
              "재시도해도 한 번만 발송되게 하는 키(출력 가능한 ASCII). 같은 프로젝트에서 같은 키로 다시 보내면 새로 큐잉하지 않고 " +
              "처음 발송을 200 과 `meta.idempotent_replay: true` 로 돌려준다(본문이 달라도). 형식이 틀리면 400.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["type"],
                properties: {
                  title: { type: "string", maxLength: 255, description: "`{{속성}}`·`{{user_id}}`·`{{속성|기본값}}` 치환 지원. template 을 쓰면 생략 가능(주면 템플릿보다 우선)" },
                  body: { type: "string", maxLength: 4000, description: "title 과 같은 치환 지원. template 을 쓰면 생략 가능" },
                  template: { type: "string", maxLength: 120, description: "콘솔 > 발송 > 템플릿 의 이름. 제목·본문·딥링크·커스텀 필드를 채운다. 없으면 404" },
                  fields: {
                    type: "object",
                    additionalProperties: { type: "string", maxLength: 500 },
                    description: "템플릿이 정의한 커스텀 필드 값 → 푸시 data. 필수 누락·정의에 없는 키는 422. template 없이 주면 422",
                  },
                  type: {
                    type: "string",
                    enum: ["single", "multi", "broadcast", "topic", "segment"],
                    description:
                      "single/topic 은 target 필수, multi 는 targets 필수, broadcast 는 전체 발송. " +
                      "segment 는 통합 전 이름으로, topic 과 똑같이 동작한다(신규 연동은 topic 을 쓸 것).",
                  },
                  target: { type: "string", maxLength: 255, description: "user_id(single) 또는 토픽 이름(topic)" },
                  targets: {
                    type: "array",
                    minItems: 1,
                    maxItems: 1000,
                    items: { type: "string", maxLength: 255 },
                    description: "multi 의 받는 사람 user_id 목록. 없는 아이디는 건너뛴다.",
                  },
                  scheduled_at: { type: "string", format: "date-time", description: "예약 발송 시각(ISO8601). 미지정 시 방해금지 시간대 규칙 적용" },
                  local_time: {
                    type: "string",
                    pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                    description:
                      "받는 사람 현지 시각 발송(\"HH:MM\"). 기기의 시간대(사람 > 기기 > 프로젝트)로 묶어 아직 그 시각이 아닌 묶음은 미룬다. 하루가 지나면 즉시 발송. 방해금지·빈도 상한과 함께 적용된다.",
                  },
                  deep_link: { type: "string", format: "uri", maxLength: 2048 },
                  image_url: { type: "string", format: "uri", maxLength: 2048, description: "리치 알림 이미지(https 만, http 는 422). Android·iOS·웹 알림에 크게 표시" },
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
                  ab_test: {
                    type: "object",
                    required: ["sample_percent", "wait_minutes"],
                    description:
                      "A/B 자동 승자. 표본(sample_percent %)에게 먼저 보내고 wait_minutes 뒤 **유니크 클릭률**이 가장 좋은 변형을 " +
                      "나머지에게 한 번 더 보낸다(발송 로그 1행 추가). 표본과 나머지는 토큰 해시 버킷으로 갈라 겹치지 않는다. " +
                      "변형이 2개 이상이어야 하고 type=single 에는 쓸 수 없다(422). 지표는 고정이라 받지 않는다. " +
                      "변형마다 도달 100건을 못 채우거나 1·2위 차이가 1%p 미만이면 승자를 선언하지 않고 이유를 남긴다.",
                    properties: {
                      sample_percent: { type: "integer", minimum: 5, maximum: 50, description: "표본 비율(%)" },
                      wait_minutes: { type: "integer", minimum: 5, maximum: 1440, description: "판정까지 기다리는 시간(분)" },
                    },
                  },
                  locales: {
                    type: "object",
                    description:
                      "로케일별 제목·본문 — `{ \"default\": {…}, \"ko\": {…}, \"ja-JP\": {…} }`. fan-out 때 사람 > 기기의 locale 로 고른다. " +
                      "정확히 맞는 태그 → 언어만 맞는 태그 → `default` → 발송 본문(title/body) 순. `ko_KR` 과 `ko-KR` 은 같은 값으로 접힌다. " +
                      "기본 문구로 떨어진 인원은 로그의 `locale_fallbacks` 와 상세 API 에 남는다 — 조용히 떨어지지 않는다. " +
                      "`variants`(A/B)와 함께 쓸 수 없고(422), 기본 문구가 어디에도 없으면 422.",
                    additionalProperties: {
                      type: "object",
                      required: ["title", "body"],
                      properties: { title: { type: "string", maxLength: 255 }, body: { type: "string", maxLength: 4000 } },
                    },
                  },
                  holdout_percent: {
                    type: "integer",
                    minimum: 1,
                    maximum: 50,
                    description:
                      "홀드아웃(대조군) 비율(%). 이 비율의 **사람에게는 아무것도 보내지 않고** 전환만 비교해 리프트를 낸다. " +
                      "배정은 사람(없으면 기기) 단위 해시로 고정이라 캠페인마다 대조군이 다시 뽑히지 않는다. type=single 에는 쓸 수 없다(422).",
                  },
                  quiet_hours: {
                    type: "boolean",
                    description:
                      "`false` 면 프로젝트 방해금지 시간대를 무시하고 즉시 보낸다. 거래성 발송(주문·인증)이 마케팅용 야간 금지에 밀리지 않게 하는 탈출구.",
                  },
                  max_sends_per_minute: {
                    type: "integer",
                    minimum: 0,
                    maximum: 1000000,
                    description:
                      "이 발송에만 적용할 분당 상한. 프로젝트 설정을 덮는다. `0` 은 \"이 발송은 제한 없음\"이고, 주지 않으면 프로젝트 설정을 따른다.",
                  },
                  options: {
                    type: "object",
                    description:
                      "알림 옵션. Android·APNs·웹 페이로드의 제자리로 나뉘어 실린다. 4KB 검사에 포함된다. " +
                      "`silent: true` 면 제목·본문 없이 data 만 보내므로 title·body 가 없어도 통과한다.",
                    properties: {
                      sound: { type: "string", maxLength: 64, description: "알림음 파일명 또는 \"default\" → Android notification.sound · APNs aps.sound" },
                      badge: { type: "integer", minimum: 0, maximum: 99999, description: "iOS 배지 수 → APNs aps.badge" },
                      collapse_key: { type: "string", maxLength: 64, description: "같은 키의 이전 알림을 덮어쓴다 → Android collapse_key · APNs apns-collapse-id" },
                      android_channel_id: { type: "string", maxLength: 64, description: "→ Android notification.channel_id" },
                      ios_thread_id: { type: "string", maxLength: 64, description: "→ APNs aps.thread-id" },
                      ttl_seconds: { type: "integer", minimum: 0, maximum: 2419200, description: "배달 유효기간(초, 최대 28일) → Android ttl · APNs apns-expiration. 0 이면 즉시 만료" },
                      priority: { type: "string", enum: ["normal", "high"], default: "high", description: "→ Android priority · normal 은 APNs apns-priority 5" },
                      silent: { type: "boolean", description: "무음 푸시(data-only) → APNs content-available. 알림을 그리지 않는다" },
                      actions: {
                        type: "array",
                        maxItems: 3,
                        description: "액션 버튼. `data.actions` 에 JSON 문자열로 실리고 앱 SDK 가 읽는다(id 중복 불가)",
                        items: {
                          type: "object",
                          required: ["id", "title"],
                          properties: {
                            id: { type: "string", maxLength: 64 },
                            title: { type: "string", maxLength: 64 },
                            deep_link: { type: "string", format: "uri", maxLength: 2048 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "큐잉됨 (worker 가 실제 발송). 본문 `{ message: { id, status, scheduled_at } }`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        status: { type: "string", enum: ["queued", "scheduled"] },
                        scheduled_at: { type: ["string", "null"], format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          "200": { description: "같은 Idempotency-Key 의 재요청 — 처음 발송을 그대로 돌려준다" },
          "400": { description: "Idempotency-Key 형식 오류" },
          "413": { description: "페이로드 초과" },
          "422": { description: "검증 실패(치환 후 FCM 페이로드 4KB 초과 포함)" },
          "429": { description: "rate limit" },
        },
      },
    },
    "/api/v1/messages/received": {
      post: {
        tags: ["App SDK"],
        summary: "단말 수신 보고 (도달 확인)",
        description:
          "알림이 **기기에 실제로 도착했을 때** SDK 가 부른다. FCM 접수(`success_count`)는 기기가 꺼져 있어도 성공하므로 " +
          "도달로 읽을 수 없다 — 이 값이 `delivered_count` 로 따로 쌓인다. " +
          "(발송, 기기) 유니크라 재시도·중복 콜백으로 여러 번 보내도 한 번만 센다.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["log_id", "token"],
                properties: {
                  log_id: { type: "string", format: "uuid", description: "푸시 data 의 `notikit_log_id`" },
                  token: { type: "string", maxLength: 4096, description: "알림을 받은 단말의 푸시 토큰" },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "접수. `{ recorded }` — `false` 면 이미 보고된 건(중복)이라 카운터를 올리지 않았다",
            content: {
              "application/json": {
                schema: { type: "object", properties: { recorded: { type: "boolean" } } },
              },
            },
          },
          "403": { description: "이 발송의 대상이 아닌 기기" },
          "404": { description: "발송 또는 기기 없음" },
          "422": { description: "검증 실패" },
          "429": { description: "rate limit" },
        },
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
                description: "user_id 또는 token 중 하나 필수. user_id 로 등록할 때는 identity_hash 필수(타 유저 수신 차단 방지).",
                properties: {
                  user_id: { type: "string", maxLength: 255 },
                  token: { type: "string", maxLength: 4096 },
                  reason: { type: "string", enum: ["opt_out", "bounced", "complaint", "manual"], default: "opt_out" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "등록됨" }, "422": { description: "user_id 또는 token 필요" } },
      },
    },
    "/api/v1/events": {
      post: {
        tags: ["App SDK"],
        summary: "전환 이벤트 보고",
        description:
          "앱에서 일어난 행동(구매·가입 등)을 **그 기기/사람이 최근 24시간 안에 클릭한 마지막 발송**에 귀속한다. " +
          "클릭이 없으면 저장하지 않고 `attributed: false` 로 202 를 준다(오류가 아니다). " +
          "같은 날 같은 (발송, 사람, 이름)은 1건만 남는다 — 재시도해도 매출이 부풀지 않는다.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                description: "token 과 user_id 중 정확히 하나. user_id 를 보낼 때는 identity_hash 필수.",
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 64, description: "전환 이름 (purchase, signup …)" },
                  value_cents: { type: "integer", minimum: 0, maximum: 1000000000, description: "금액(최소 화폐 단위). 금액 없는 전환은 생략" },
                  token: { type: "string", maxLength: 4096, description: "알림을 받은 기기의 푸시 토큰. user_id 와 배타." },
                  user_id: { type: "string", maxLength: 255, description: "그 사람의 모든 기기 클릭이 후보. token 과 배타." },
                  identity_hash: { type: "string", maxLength: 128, description: "HMAC-SHA256(user_id, api_secret). user_id 를 보낼 때 필수." },
                },
              },
            },
          },
        },
        responses: {
          "202": { description: "처리됨. 본문 `{ recorded, attributed, message_id? }`" },
          "403": { description: "user_id 에 identity_hash 누락·불일치" },
          "404": { description: "디바이스 또는 유저 없음" },
          "422": { description: "token 과 user_id 중 정확히 하나가 필요" },
          "429": { description: "rate limit" },
        },
      },
    },
    "/api/v1/inbox": {
      get: {
        tags: ["App SDK"],
        summary: "인앱 인박스 조회 (유저별 알림 목록)",
        description: "본인 데이터만 조회 가능 — `identity_hash` 필수(IDOR 방지).",
        security: [{ apiKey: [] }],
        parameters: [
          { name: "user_id", in: "query", required: true, schema: { type: "string" } },
          { name: "identity_hash", in: "query", required: true, schema: { type: "string" }, description: "HMAC-SHA256(user_id, api_secret)" },
        ],
        responses: { "200": { description: "최근 50건 + unread 수" }, "403": { description: "identity_hash 불일치/누락" }, "422": { description: "user_id 필요" } },
      },
    },
    "/api/v1/inbox/read": {
      post: {
        tags: ["App SDK"],
        summary: "인박스 읽음 처리",
        description: "본인 데이터만 처리 가능 — `identity_hash` 필수(IDOR 방지).",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["user_id", "identity_hash"],
                properties: {
                  user_id: { type: "string", maxLength: 255 },
                  identity_hash: { type: "string", maxLength: 128, description: "HMAC-SHA256(user_id, api_secret)" },
                  notification_id: { type: "string", format: "uuid", description: "미지정 시 전체 읽음 처리" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "읽음 처리됨" }, "403": { description: "identity_hash 불일치/누락" } },
      },
    },
    "/api/v1/journeys/enroll": {
      post: {
        tags: ["App SDK"],
        summary: "저니(워크플로) 등록",
        description: "타 유저 대상 지정 방지 — `identity_hash` 필수.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["journey", "user_id", "identity_hash"],
                properties: {
                  journey: { type: "string", minLength: 1, maxLength: 120, description: "저니 이름" },
                  user_id: { type: "string", minLength: 1, maxLength: 255 },
                  identity_hash: { type: "string", maxLength: 128, description: "HMAC-SHA256(user_id, api_secret)" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "신규 등록됨" },
          "200": { description: "이미 등록됨 (멱등)" },
          "403": { description: "identity_hash 불일치/누락" },
          "404": { description: "저니 없음" },
        },
      },
    },
    "/api/health": {
      get: { tags: ["App SDK"], summary: "헬스체크", security: [], responses: { "200": { description: "ok" } } },
    },
    "/api/openapi.json": {
      get: { tags: ["App SDK"], summary: "OpenAPI 3.1 스펙(JSON)", security: [], responses: { "200": { description: "스펙" } } },
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
                  quiet_start_hour: { type: ["integer", "null"], minimum: 0, maximum: 23 },
                  quiet_end_hour: { type: ["integer", "null"], minimum: 0, maximum: 23 },
                  frequency_cap_per_day: {
                    type: ["integer", "null"],
                    minimum: 1,
                    maximum: 100,
                    description: "한 사람이 24시간 동안 받을 수 있는 푸시 수. null 이면 제한 없음",
                  },
                  max_sends_per_minute: {
                    type: ["integer", "null"],
                    minimum: 1,
                    maximum: 100000,
                    description: "프로젝트 분당 발송 상한(기기 수). 소진하면 다음 분까지 미뤘다 이어 보낸다. null 이면 제한 없음",
                  },
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
    "/api/admin/projects/{id}/logs/{logId}/cancel": {
      post: {
        tags: ["Web Admin"],
        summary: "발송 취소",
        description:
          "대기·예약·진행 중인 발송을 멈춘다. 상태가 `canceled` 가 되면 클레임 조건에서 빠져 어떤 워커도 다시 집지 않고, " +
          "진행 중이던 워커는 소유권을 잃어 다음 페이지를 넘기지 않는다. " +
          "응답은 **취소 시점까지 이미 나간 수**(`sent`)를 함께 준다 — 대형 발송은 버튼을 누르는 순간 이미 수만 건이 나간 뒤일 수 있다. " +
          "끝난 발송(completed/logged/failed)과 이미 취소된 것은 409.",
        security: [{ adminToken: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "logId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "취소됨",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    log: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        status: { type: "string", enum: ["canceled"] },
                        canceled_at: { type: ["string", "null"], format: "date-time" },
                        canceled_by: { type: ["string", "null"] },
                        sent: {
                          type: "object",
                          description: "취소 시점까지 이미 나간 수. 숨기지 않는다.",
                          properties: {
                            total: { type: "integer" },
                            success: { type: "integer" },
                            failure: { type: "integer" },
                            holdout: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "origin 또는 권한 없음" },
          "404": { description: "발송 없음" },
          "409": { description: "이미 끝났거나 취소된 발송" },
        },
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
    "/api/admin/projects/{id}/audience/estimate": {
      post: {
        tags: ["Web Admin"],
        summary: "발송 전 도달 인원 추정",
        description: "발송과 같은 대상 필드. 활성 기기만, 수신거부 제외 — 실제 발송의 대상 수와 같은 함수로 센다.",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["type"],
                properties: {
                  type: { type: "string", enum: ["single", "multi", "broadcast", "topic", "segment"] },
                  target: { type: "string", maxLength: 255 },
                  targets: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 255 } },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ users, devices, platforms: { ios, android, web, other } } — other 는 flutter·react-native 등 OS 를 알 수 없는 기기" },
          "422": { description: "대상 필드 누락" },
        },
      },
    },
    "/api/admin/projects/{id}/audience/topics": {
      get: {
        tags: ["Web Admin"],
        summary: "토픽 목록",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "목록 — rules 가 있으면 규칙식, 없으면 구독식" } },
      },
      post: {
        tags: ["Web Admin"],
        summary: "토픽 생성",
        description: "rules 를 주면 규칙식, 안 주면 구독식. 만든 뒤에는 방식을 바꿀 수 없다.",
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
                    minItems: 1,
                    maxItems: 20,
                    description: "AND 로 묶인 속성 동등 조건. 0개는 전체 발송이 되므로 허용하지 않는다.",
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
        responses: {
          "201": { description: "생성됨" },
          "200": { description: "같은 이름·같은 방식의 그룹이 이미 있음" },
          "409": { description: "같은 이름인데 채우는 방식이 다름" },
        },
      },
    },
    "/api/admin/projects/{id}/audience/topics/{topicId}": {
      get: {
        tags: ["Web Admin"],
        summary: "토픽 단건 (+ 대상 규모)",
        security: [{ adminToken: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "topicId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: { "200": { description: "그룹 + deviceCount/userCount" }, "404": { description: "없음" } },
      },
      patch: {
        tags: ["Web Admin"],
        summary: "규칙 수정",
        description:
          "규칙식 그룹의 조건만 바꾼다. 이름은 바꿀 수 없다 — 발송 로그가 이름으로 대상을 찾아서, " +
          "바꾸면 예약된 발송이 0명에게 나간다.",
        security: [{ adminToken: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "topicId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["rules"],
                properties: {
                  rules: {
                    type: "array",
                    minItems: 1,
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
        responses: {
          "200": { description: "저장됨" },
          "404": { description: "없음" },
          "409": { description: "구독식 그룹 — 고칠 규칙이 없음" },
        },
      },
      delete: {
        tags: ["Web Admin"],
        summary: "토픽 삭제",
        security: [{ adminToken: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "topicId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: { "200": { description: "삭제됨 — 구독은 cascade" }, "404": { description: "없음" } },
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
                        hours: { type: "integer", minimum: 0, maximum: 8760, description: "wait 스텝 대기 시간(최대 1년)" },
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
    "/api/admin/projects/{id}/messages": {
      post: {
        tags: ["Web Admin"],
        summary: "콘솔에서 푸시 발송 (admin 세션/역할 인가 — api-secret 불필요)",
        security: [{ adminToken: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
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
                  type: { type: "string", enum: ["single", "broadcast", "topic", "segment"] },
                  target: { type: "string", maxLength: 255, description: "broadcast 외 필수" },
                  scheduled_at: { type: "string", format: "date-time" },
                  local_time: {
                    type: "string",
                    pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                    description:
                      "받는 사람 현지 시각 발송(\"HH:MM\"). 기기의 시간대(사람 > 기기 > 프로젝트)로 묶어 아직 그 시각이 아닌 묶음은 미룬다. 하루가 지나면 즉시 발송. 방해금지·빈도 상한과 함께 적용된다.",
                  },
                  deep_link: { type: "string", format: "uri", maxLength: 2048 },
                  image_url: { type: "string", format: "uri", maxLength: 2048, description: "리치 알림 이미지(https 만, http 는 422). Android·iOS·웹 알림에 크게 표시" },
                  test: { type: "boolean", description: "테스트 발송 표시(로그 isTest). 콘솔 라우트에서만 반영" },
                  data: { type: "object", additionalProperties: true },
                  variants: {
                    type: "array",
                    minItems: 2,
                    maxItems: 5,
                    items: { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" } } },
                  },
                  ab_test: {
                    type: "object",
                    required: ["sample_percent", "wait_minutes"],
                    description: "A/B 자동 승자(표본 %·판정 대기 분). 지표는 유니크 클릭률 고정. v1 과 같은 규칙.",
                    properties: {
                      sample_percent: { type: "integer", minimum: 5, maximum: 50 },
                      wait_minutes: { type: "integer", minimum: 5, maximum: 1440 },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "202": { description: "큐잉됨" }, "403": { description: "권한 없음(viewer)/Origin" }, "422": { description: "검증 실패" } },
      },
    },
  },
} as const;
