-- 발송 속도 제한(분당 N건). null 이면 제한 없음 — 칼럼이 없던 때와 같은 동작이라
-- 기존 프로젝트의 발송 속도가 마이그레이션만으로 달라지지 않는다.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "max_sends_per_minute" integer;
--> statement-breakpoint
-- 받는 사람 현지 시각 발송("HH:MM"). null 이면 예전처럼 도래 즉시 전원에게 보낸다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "local_time" text;
--> statement-breakpoint
-- 토큰별 일시 실패의 사유별 건수. 실패 수만 세면 쿼터 문제와 죽은 토큰을 구분할 수 없다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "delivery_errors" jsonb;
--> statement-breakpoint
-- 속도 제한 예산: 프로젝트 × 1분 창. 워커가 여러 대면 메모리 카운터는 창마다 워커 수만큼 예산을 늘린다.
CREATE TABLE IF NOT EXISTS "push_rate_counters" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_rate_counters_pk" PRIMARY KEY("project_id","window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_rate_counters_window_idx" ON "push_rate_counters" ("window_start");
--> statement-breakpoint
-- 반복 예약(daily/weekly/monthly + 시:분). 워커가 도래분마다 push_logs 1행을 만든다.
CREATE TABLE IF NOT EXISTS "push_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"weekday" smallint,
	"day_of_month" smallint,
	"hour" smallint NOT NULL,
	"minute" smallint NOT NULL,
	"message" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_schedules_project_idx" ON "push_schedules" ("project_id");
--> statement-breakpoint
-- 워커의 도래분 스캔 — 꺼진 예약은 인덱스에서 뺀다
CREATE INDEX IF NOT EXISTS "push_schedules_due_idx" ON "push_schedules" ("next_run_at") WHERE "enabled";
