-- 알림 옵션(소리·배지·collapse·TTL·우선순위·무음·액션 버튼). 발송 한 건에 한 벌이라 컬럼 하나에 담는다 —
-- 컬럼으로 쪼개면 옵션이 늘 때마다 스키마가 바뀌고, 어차피 전부 FCM 페이로드로만 나간다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "options" jsonb;
--> statement-breakpoint
-- 변형별 클릭률을 내려면 클릭이 어느 변형이었는지 알아야 한다. 기존 클릭은 판정할 근거가 없어 null 로 둔다.
ALTER TABLE "push_clicks" ADD COLUMN IF NOT EXISTS "variant" smallint;
--> statement-breakpoint
-- 전환 귀속이 "이 기기의 최근 클릭"을 찾는다 — 기기 경로에 인덱스가 없으면 프로젝트의 클릭 전체를 훑는다
CREATE INDEX IF NOT EXISTS "push_clicks_device_idx" ON "push_clicks" ("project_id", "device_id", "clicked_at");
--> statement-breakpoint
-- 전환 이벤트. 귀속은 기록 시점에 끝나므로 클릭이 지워져도 과거 성과가 흔들리지 않는다.
CREATE TABLE IF NOT EXISTS "push_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"log_id" uuid NOT NULL REFERENCES "push_logs"("id") ON DELETE CASCADE,
	"user_id" uuid REFERENCES "push_users"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"value_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_conversions_log_idx" ON "push_conversions" ("log_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_conversions_project_idx" ON "push_conversions" ("project_id", "created_at");
--> statement-breakpoint
-- 같은 (발송, 사람, 이름)은 하루 1건. 익명 기기(user_id null)도 한 사람으로 묶이도록 coalesce 한다 —
-- NULL 끼리는 서로 다른 값이라 그대로 두면 유니크가 익명 기기에 전혀 걸리지 않는다.
-- 날짜는 UTC 로 고정한다: created_at::date 는 세션 TimeZone 에 따라 달라져 인덱스에 쓸 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS "push_conversions_uniq_idx" ON "push_conversions" (
	"log_id",
	coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid),
	"name",
	(("created_at" at time zone 'utc')::date)
);
