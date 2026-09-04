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
  apiSecret: text("api_secret").notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projIdx: index("push_logs_project_idx").on(t.projectId, t.createdAt),
}));

export type Project = typeof projects.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type PushUser = typeof pushUsers.$inferSelect;
export type PushLog = typeof pushLogs.$inferSelect;
