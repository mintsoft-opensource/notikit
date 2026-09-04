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
  locale: text("locale"),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  extIdx: uniqueIndex("push_users_ext_idx").on(t.projectId, t.externalId),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("push_logs_project_idx").on(t.projectId, t.createdAt),
  statusIdx: index("push_logs_status_idx").on(t.projectId, t.status),
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

export type Project = typeof projects.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type PushUser = typeof pushUsers.$inferSelect;
export type PushLog = typeof pushLogs.$inferSelect;
