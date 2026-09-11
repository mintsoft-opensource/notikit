import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  doublePrecision,
  inet,
  bigint,
  date,
} from "drizzle-orm/pg-core";

/** 조직/워크스페이스 (테넌트 최상위) */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 관리자 계정 */
export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("owner"), // owner | admin | viewer
  // 세션 무효화용 버전. 로그아웃/비번변경 시 증가 → 기존 발급 토큰 전부 무효.
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  emailIdx: uniqueIndex("admin_users_email_idx").on(t.email),
}));

/** 프로젝트 (앱 단위 테넌트) — 프로젝트별 Firebase 자격증명·API키 격리 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  environment: text("environment").notNull().default("production"), // dev | staging | production
  apiKey: text("api_key").notNull(),
  // api-secret 암호문 (AES-256-GCM at-rest)
  apiSecretEnc: text("api_secret_enc").notNull(),
  // external_id 바인딩에 identity 검증(HMAC) 요구 여부
  requireIdentityVerification: boolean("require_identity_verification").notNull().default(true),
  // 방해금지 시간대 (UTC 시각 0-23). 이 구간 발송은 종료 시각으로 자동 예약.
  quietStartHour: integer("quiet_start_hour"),
  quietEndHour: integer("quiet_end_hour"),
  // Firebase service account JSON — AES-256-GCM 암호문
  firebaseCredentialsEnc: text("firebase_credentials_enc"),
  // 카카오 알림톡 설정(provider_url/api_key/sender_key) — AES-256-GCM 암호문
  kakaoConfigEnc: text("kakao_config_enc"),
  // 마지막으로 **완주한** 토큰 스윕 시각 — 하루 1회 판단 기준
  tokensCheckedAt: timestamp("tokens_checked_at", { withTimezone: true }),
  // 스윕 재개 지점(devices.id). null 이면 진행 중인 스윕이 없다.
  // 토큰이 많아 한 번에 끝나지 않는 프로젝트는 여기서 이어서 돈다.
  tokensCheckCursor: uuid("tokens_check_cursor"),
  // 진행 중 스윕의 리스. 워커가 죽으면 만료되어 다른 워커가 이어받는다.
  // 정상적으로 한 구간을 마치면 null 로 풀어 즉시 이어 돌 수 있게 한다.
  tokensSweepLeaseAt: timestamp("tokens_sweep_lease_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  apiKeyIdx: uniqueIndex("projects_api_key_idx").on(t.apiKey),
  orgIdx: index("projects_org_idx").on(t.orgId),
}));

/** 플랫폼 앱 (android/ios/web/webview/electron) */
export const apps = pgTable("apps", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // android | ios | web | webview | electron | flutter | react-native
  bundleId: text("bundle_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("apps_project_idx").on(t.projectId),
}));

/** 푸시 유저 (외부 유저 식별자 매핑 = identity 레이어의 핵심) */
export const pushUsers = pgTable("push_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(), // 고객 시스템의 유저 ID
  attributes: jsonb("attributes").$type<Record<string, unknown>>().default({}),
  phone: text("phone"), // 카카오 알림톡 폴백용
  locale: text("locale"),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  extIdx: uniqueIndex("push_users_ext_idx").on(t.projectId, t.externalId),
  // 목록 커서용 — 없으면 정렬을 인덱스로 못 타서 전건 스캔 + 상관 서브쿼리가
  // 반환 행이 아니라 스캔 행마다 실행된다
  createdIdx: index("push_users_created_idx").on(t.projectId, t.createdAt),
}));

/** 디바이스 (토큰) — 유저에 연결(다중 기기) */
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => pushUsers.id, { onDelete: "set null" }),
  token: text("token").notNull(),
  platform: text("platform").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  appVersion: text("app_version"),
  osVersion: text("os_version"),
  locale: text("locale"),
  timezone: text("timezone"),
  country: text("country"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow(),
  // FCM 이 이 토큰을 받아들인 마지막 시각. 등록만으로는 토큰이 진짜인지 알 수 없어
  // (공개 api-key + 임의 문자열로 등록이 된다) 실제 발송이나 dry-run 검증에 성공했을 때만 찍는다.
  // 미검증 기기가 통계에 섞여도 최소한 그 규모가 보이게 하는 것이 목적이다.
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tokenIdx: uniqueIndex("devices_token_idx").on(t.projectId, t.token),
  userIdx: index("devices_user_idx").on(t.userId),
  projIdx: index("devices_project_idx").on(t.projectId),
}));

/** 토픽 */
export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameIdx: uniqueIndex("topics_name_idx").on(t.projectId, t.name),
}));

/** 토픽 구독 */
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  topicId: uuid("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex("subscriptions_uniq_idx").on(t.topicId, t.deviceId),
}));

/** 푸시 템플릿 (변수 치환) */
export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 억제 리스트 (절대 발송 안 함) */
export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  externalId: text("external_id"),
  token: text("token"),
  reason: text("reason").notNull().default("opt_out"), // opt_out | bounced | complaint | manual
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("suppressions_project_idx").on(t.projectId),
}));

/** 푸시 로그 (발송 이력 — 대량, 리텐션 대상) */
export const pushLogs = pgTable("push_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // single | broadcast | topic
  target: text("target"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  deepLink: text("deep_link"),
  status: text("status").notNull().default("queued"), // queued | processing | completed | failed
  totalCount: integer("total_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  readCount: integer("read_count").notNull().default(0),
  // 워커 클레임 시각/토큰 — 크래시 복구 + fencing(재클레임 시 원 워커 부작용 차단)
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockToken: text("lock_token"),
  // 예약 발송 — 미래면 status='scheduled', 워커가 도래 시 처리
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  // A/B 변형 (있으면 수신자를 해시로 변형에 배정) + 변형별 집계
  variants: jsonb("variants").$type<{ title: string; body: string }[]>(),
  variantStats: jsonb("variant_stats").$type<Record<string, { sent: number; success: number }>>(),
  // 카카오 알림톡 폴백 (단건 발송에서 device 실패/부재 시 phone 으로)
  kakaoFallback: boolean("kakao_fallback").notNull().default(false),
  kakaoCount: integer("kakao_count").notNull().default(0),
  // 클릭률 분모 — 발송 시점 스냅샷. 구독은 계속 변하므로 나중에 세면 과거 발송의 비율이 흔들린다.
  audienceUserCount: integer("audience_user_count").notNull().default(0),
  // clickCount(디바이스 단위 분자)의 짝. 익명 디바이스는 유저 분모에 0으로 잡히므로
  // clickCount/audienceUserCount 를 쓰면 100% 를 넘는 비율이 나온다.
  audienceDeviceCount: integer("audience_device_count").notNull().default(0),
  // 클릭률 분자 — push_clicks 집계 캐시(유니크 클릭 기준)
  clickCount: integer("click_count").notNull().default(0),
  clickUserCount: integer("click_user_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("push_logs_project_idx").on(t.projectId, t.createdAt),
  statusIdx: index("push_logs_status_idx").on(t.projectId, t.status),
}));

/**
 * 일별 접속 롤업 — 디바이스가 활동한 날 하루당 한 행.
 *
 * 접속을 이벤트로 전부 쌓으면 앱을 열 때마다 행이 생겨 감당이 안 된다. 하루 단위로
 * 접어두면 DAU/WAU/MAU 와 추이를 낼 수 있으면서 크기가 (디바이스 × 활동일)로 묶인다.
 * devices.lastActiveAt 은 "마지막"만 알려주므로 과거 추이를 만들 수 없다.
 *
 * day 는 UTC 날짜다. 서버 로컬시각을 쓰면 배포 지역에 따라 같은 데이터가 다르게 집계된다.
 */
export const deviceActivity = pgTable("device_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => pushUsers.id, { onDelete: "set null" }),
  platform: text("platform"),
  day: date("day").notNull(),
  // 그 날 몇 번 열었는지 — DAU 와 별개로 사용 강도를 본다
  opens: integer("opens").notNull().default(1),
  /** 접속 IP 로 판정한 국가. 프록시 신뢰 설정이 없으면 null 이다. */
  country: text("country"),
  /**
   * 마스킹한 접속 IP (IPv4 /24, IPv6 /48).
   *
   * 원본은 개인정보라 남기지 않는다. 국가 판정은 마스킹 전 값으로 하고 결과만 둔다.
   */
  ipMasked: text("ip_masked"),
  lastAt: timestamp("last_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqDay: uniqueIndex("device_activity_uniq_idx").on(t.deviceId, t.day),
  projDayIdx: index("device_activity_day_idx").on(t.projectId, t.day),
}));

/**
 * 디바이스 생애 이벤트 — 앱 삭제/재설치 추적.
 *
 * FCM 이 `registration-token-not-registered` 를 돌려주는 것이 사실상 유일한 **앱 삭제 신호**다.
 * 발송 경로와 야간 스윕 양쪽에서 이 판정이 나오는데, 지금까지는 토큰을 비활성화만 하고
 * 버렸다. 여기 남겨야 "언제 몇 명이 지웠는지"를 볼 수 있다.
 *
 * 한계: FCM 이 토큰을 무효로 표시하기까지 지연이 있어 실제 삭제 시각보다 늦다.
 * 앱 삭제와 토큰 회전을 완전히 구분하지도 못한다 — 재설치는 reinstalled 로 잡힌다.
 */
export const deviceEvents = pgTable("device_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => pushUsers.id, { onDelete: "set null" }),
  platform: text("platform"),
  event: text("event").notNull(), // uninstalled | reinstalled
  // 어디서 감지했는지 — send(실제 발송 응답) 가 sweep(주기 검사) 보다 신뢰도가 높다
  source: text("source").notNull(), // send | sweep | register
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("device_events_project_idx").on(t.projectId, t.at),
  eventIdx: index("device_events_event_idx").on(t.projectId, t.event, t.at),
}));

/**
 * 푸시 클릭(알림 탭) 이벤트. 디바이스당 발송 1건에 1행 — 재클릭은 무시(유니크)해서
 * 클릭률이 부풀지 않게 한다. userId 는 클라이언트가 보낸 값이 아니라 서버가
 * devices.userId 바인딩에서 해석한 값이다(사칭 방지).
 */
export const pushClicks = pgTable("push_clicks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  logId: uuid("log_id").notNull().references(() => pushLogs.id, { onDelete: "cascade" }),
  // NOT NULL + cascade. nullable 이면 (log_id, device_id) 유니크가 NULL 을 서로 다른 값으로
  // 취급해 방어가 뚫린다 — 디바이스 삭제 기능이 생기는 순간 중복 클릭이 들어온다.
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => pushUsers.id, { onDelete: "set null" }),
  platform: text("platform"),
  // 클릭으로 이동한 목적지 — 발송의 deepLink 와 다를 수 있어 실제 착지점을 따로 남긴다
  destination: text("destination"),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqDevice: uniqueIndex("push_clicks_uniq_idx").on(t.logId, t.deviceId),
  logIdx: index("push_clicks_log_idx").on(t.logId),
  userIdx: index("push_clicks_user_idx").on(t.projectId, t.userId),
  atIdx: index("push_clicks_at_idx").on(t.projectId, t.clickedAt),
}));

/** 아웃바운드 웹훅 엔드포인트 */
export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(), // HMAC 서명용
  events: jsonb("events").$type<string[]>().notNull().default([]), // 구독 이벤트 (빈배열=전체)
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("webhooks_project_idx").on(t.projectId),
}));

/** 웹훅 전송 로그 (재시도/관측) */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"), // pending | delivered | failed
  attempts: integer("attempts").notNull().default(0),
  lastStatusCode: integer("last_status_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  whIdx: index("webhook_deliveries_wh_idx").on(t.webhookId, t.status),
}));

/** 저니(워크플로우) — 다단계 자동 발송 정의 */
export const journeys = pgTable("journeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // 스텝: [{type:'send', title, body} | {type:'wait', hours}]
  steps: jsonb("steps").$type<Array<{ type: "send" | "wait"; title?: string; body?: string; hours?: number }>>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameIdx: uniqueIndex("journeys_name_idx").on(t.projectId, t.name),
}));

/** 저니 실행 — 유저별 진행 상태 */
export const journeyRuns = pgTable("journey_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => pushUsers.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").notNull().default(0),
  status: text("status").notNull().default("active"), // active | completed
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  dueIdx: index("journey_runs_due_idx").on(t.projectId, t.status, t.nextRunAt),
  // 멱등성: 한 유저는 한 저니에 1회만 등록
  uniqRun: uniqueIndex("journey_runs_uniq_idx").on(t.journeyId, t.userId),
}));

/** 세그먼트 — 유저 속성 규칙 기반 오디언스 */
export const segments = pgTable("segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // 규칙 (AND): [{ attribute, value }] — attributes->>attribute = value
  rules: jsonb("rules").$type<{ attribute: string; value: string }[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameIdx: uniqueIndex("segments_name_idx").on(t.projectId, t.name),
}));

/** In-app 인박스 — 유저별 알림 이력 (푸시 놓쳐도 앱에서 확인) */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => pushUsers.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  deepLink: text("deep_link"),
  data: jsonb("data").$type<Record<string, unknown>>(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index("notifications_user_idx").on(t.projectId, t.userId, t.createdAt),
}));

/**
 * 호스트 메트릭 시계열 — 웹 인스턴스가 주기적으로(기본 60s) 적재.
 * 인스턴스별로 자기 행을 쓰므로 다중 인스턴스에서도 각 호스트를 구분해 볼 수 있다.
 * 보존 기간은 SYSTEM_METRICS_RETENTION_DAYS(기본 7일) 로 purge.
 */
export const systemMetrics = pgTable("system_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  instanceId: text("instance_id").notNull(),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  cpuPct: doublePrecision("cpu_pct"),
  loadavg1: doublePrecision("loadavg_1"),
  memUsedBytes: bigint("mem_used_bytes", { mode: "number" }),
  memTotalBytes: bigint("mem_total_bytes", { mode: "number" }),
  rssBytes: bigint("rss_bytes", { mode: "number" }),
  heapBytes: bigint("heap_bytes", { mode: "number" }),
  netRxBps: doublePrecision("net_rx_bps"),
  netTxBps: doublePrecision("net_tx_bps"),
  loopP50Ms: doublePrecision("loop_p50_ms"),
  loopP99Ms: doublePrecision("loop_p99_ms"),
}, (t) => ({
  atIdx: index("system_metrics_at_idx").on(t.at),
  instanceIdx: index("system_metrics_instance_idx").on(t.instanceId, t.at),
}));

/**
 * ISO 3166-1 국가 — 표기용 참조 데이터.
 *
 * devices.country 는 클라이언트가 보고하거나 IP 로 판정한 코드가 들어간다. 표기할 때
 * 코드(KR)만으로는 읽기 어려우므로 이름을 붙이려고 둔다.
 */
export const countries = pgTable("countries", {
  /** ISO 3166-1 alpha-2 (대문자) */
  code: text("code").primaryKey(),
  nameKo: text("name_ko").notNull(),
  nameEn: text("name_en").notNull(),
  /** 대륙 단위 묶어보기용 (Asia, Europe …) */
  region: text("region"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * IP → 국가 구간. 출처: DB-IP Lite (CC BY 4.0).
 *
 * 조회는 "시작 IP 가 대상보다 작거나 같은 것 중 가장 큰 것"을 잡고 끝 IP 로 확인한다.
 * start_ip 내림차순 인덱스 하나로 끝나 GiST 나 ip4r 확장이 필요 없다.
 *
 * family 를 함께 두는 이유: Postgres 는 inet 비교에서 IPv4 를 IPv6 보다 앞에 놓는다.
 * 필터가 없으면 IPv6 조회가 "더 작은" IPv4 구간을 잘못 집는다.
 */
export const ipCountryRanges = pgTable("ip_country_ranges", {
  startIp: inet("start_ip").notNull(),
  endIp: inet("end_ip").notNull(),
  /** 4 또는 6 */
  family: integer("family").notNull(),
  countryCode: text("country_code").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.family, t.startIp] }),
  lookupIdx: index("ip_country_lookup_idx").on(t.family, t.startIp),
}));

/**
 * 위치 데이터 적재 이력 — import-geo.mjs 한 번 실행에 한 행.
 *
 * 이 데이터는 외부 원본을 통째로 갈아끼우므로, 언제 무엇이 몇 건 들어왔는지 남지
 * 않으면 "국가가 왜 안 나오는가"를 추적할 방법이 없다. 실패도 남긴다 — 실패가
 * 조용하면 낡은 데이터로 계속 판정하게 된다.
 */
export const geoImports = pgTable("geo_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** ok | failed */
  status: text("status").notNull(),
  countries: integer("countries").notNull().default(0),
  ipv4: integer("ipv4").notNull().default(0),
  ipv6: integer("ipv6").notNull().default(0),
  /** 실패 사유. 성공이면 null */
  error: text("error"),
}, (t) => ({
  startedIdx: index("geo_imports_started_idx").on(t.startedAt),
}));

export type GeoImport = typeof geoImports.$inferSelect;
export type Country = typeof countries.$inferSelect;
export type IpCountryRange = typeof ipCountryRanges.$inferSelect;

export type Project = typeof projects.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type PushUser = typeof pushUsers.$inferSelect;
export type PushLog = typeof pushLogs.$inferSelect;
export type PushClick = typeof pushClicks.$inferSelect;
export type DeviceActivity = typeof deviceActivity.$inferSelect;

/**
 * 자동 업데이트 작업.
 *
 * 콘솔과 업데이터 사이의 **유일한 통신 수단**이다. 콘솔이 여기에 행을 넣으면
 * 업데이터가 집어 간다. 이렇게 두는 이유는 web 컨테이너에 Docker 소켓을 주지 않기
 * 위해서다 — 소켓은 사실상 호스트 root 권한이라, 공개 API 를 서빙하는 프로세스가
 * 쥐고 있어선 안 된다. 권한은 업데이터 한 곳에만 갇힌다.
 *
 * 진행 상황도 여기 쌓인다. 업데이트는 web 을 재시작시키므로, 그동안 콘솔은 응답하지
 * 못한다. 상태가 DB 에 있어야 돌아온 뒤 무슨 일이 있었는지 이어서 볼 수 있다.
 */
export const updateJobs = pgTable("update_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromVersion: text("from_version").notNull(),
  targetVersion: text("target_version").notNull(),
  /** 승인 시점의 레지스트리 경로와 다이제스트. 업데이터는 이것만 보고 받는다 —
   *  다시 조회하면 그 사이 답이 바뀌어 승인한 것과 다른 이미지가 설치될 수 있다. */
  image: text("image").notNull(),
  digest: text("digest").notNull(),
  /** 스키마를 바꾸는 릴리스인가. 백업 없이는 진행하지 않는다 */
  hasMigrations: boolean("has_migrations").notNull().default(false),
  /**
   * 폐쇄망 반입 번들 파일명. 있으면 레지스트리로 나가지 않고 이 번들에서 꺼낸다.
   * 파일명만 담는다 — 경로를 담으면 콘솔이 업데이터에게 임의 경로를 읽히게 된다.
   */
  bundlePath: text("bundle_path"),
  /** pending | running | succeeded | failed */
  status: text("status").notNull().default("pending"),
  /** pull | backup | migrate | restart | verify — 실패했을 때 어디서 멎었는지 */
  step: text("step"),
  /** 업데이터가 덧붙이는 진행 로그. 실패 원인을 사람이 읽을 수 있어야 한다 */
  log: text("log").notNull().default(""),
  /** 마이그레이션 전 덤프 위치. 되돌릴 길이 여기밖에 없다 */
  backupPath: text("backup_path"),
  error: text("error"),
  /** 누가 눌렀는지. superadmin 토큰이면 null */
  requestedBy: uuid("requested_by").references(() => adminUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => ({
  createdIdx: index("update_jobs_created_idx").on(t.createdAt),
}));

export type UpdateJob = typeof updateJobs.$inferSelect;
