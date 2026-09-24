-- 발송 취소. status='canceled' 는 클레임 조건(queued/scheduled/processing)에 없으므로
-- 취소된 로그는 어떤 워커도 다시 집지 않는다. 이미 나간 수는 취소 시점에 함께 굳힌다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "canceled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "canceled_by" text;
--> statement-breakpoint
-- 로케일별 제목·본문 `{ default: {...}, ko: {...} }`. null 이면 칼럼이 없던 때와 같다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "locale_variants" jsonb;
--> statement-breakpoint
-- 폴백 관측 `{ total, byLocale: { "fr": 8, "": 4 } }`. 조용한 폴백은 믿을 수 없다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "locale_fallbacks" jsonb;
--> statement-breakpoint
-- 홀드아웃(대조군) 비율과 실제로 빠진 기기 수.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "holdout_percent" smallint;
--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "holdout_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 단말이 실제로 받았다고 보고한 수. FCM 수락(success_count)과 다른 축이다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "delivered_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 캠페인별 재정의 — 거래성 발송이 마케팅용 방해금지·속도 제한을 물려받지 않게 한다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "ignore_quiet_hours" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "max_sends_per_minute" integer;
--> statement-breakpoint
-- 홀드아웃 전환은 클릭 없이 귀속된다 — 보낸 쪽 전환과 같은 칸에 섞으면 리프트가 거꾸로 나온다.
ALTER TABLE "push_conversions" ADD COLUMN IF NOT EXISTS "holdout" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 저니 분기가 "직전 발송"을 찾을 때 다른 저니의 발송을 집지 않도록.
ALTER TABLE "journey_runs" ADD COLUMN IF NOT EXISTS "last_send_log_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "journey_runs" ADD CONSTRAINT "journey_runs_last_send_log_id_push_logs_id_fk"
		FOREIGN KEY ("last_send_log_id") REFERENCES "push_logs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- 로그 삭제(리텐션 purge)의 set null 이 이 인덱스로 대상 런을 찾는다
CREATE INDEX IF NOT EXISTS "journey_runs_last_send_idx" ON "journey_runs" ("last_send_log_id") WHERE "last_send_log_id" is not null;
--> statement-breakpoint
-- 단말 수신 보고. (log_id, device_id) 기본키라 SDK 가 재시도해도 한 번만 센다.
CREATE TABLE IF NOT EXISTS "push_receipts" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"log_id" uuid NOT NULL REFERENCES "push_logs"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
	"platform" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_receipts_pk" PRIMARY KEY("log_id","device_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_receipts_project_idx" ON "push_receipts" ("project_id","received_at");
--> statement-breakpoint
-- 홀드아웃 명단. 남기지 않으면 나중에 누가 대조군이었는지 복원할 수 없다(기기 집합은 계속 변한다).
CREATE TABLE IF NOT EXISTS "push_holdouts" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"log_id" uuid NOT NULL REFERENCES "push_logs"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
	"user_id" uuid REFERENCES "push_users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_holdouts_pk" PRIMARY KEY("log_id","device_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_holdouts_device_idx" ON "push_holdouts" ("project_id","device_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_holdouts_user_idx" ON "push_holdouts" ("project_id","user_id","created_at");
--> statement-breakpoint
-- 감사 로그. 조직 단위 행위는 프로젝트에 매이지 않아 project_id 는 nullable 이고,
-- 프로젝트가 지워져도 "누가 언제 지웠는지"는 남아야 하므로 set null 이다.
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
	"actor" text NOT NULL,
	"actor_user_id" uuid REFERENCES "admin_users"("id") ON DELETE set null,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"ip_masked" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_idx" ON "audit_logs" ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_project_idx" ON "audit_logs" ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" ("org_id","action","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" ("org_id","actor","created_at");
