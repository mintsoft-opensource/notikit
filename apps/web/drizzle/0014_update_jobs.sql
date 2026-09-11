CREATE TABLE IF NOT EXISTS "update_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_version" text NOT NULL,
  "target_version" text NOT NULL,
  "image" text NOT NULL,
  "digest" text NOT NULL,
  "has_migrations" boolean DEFAULT false NOT NULL,
  "bundle_path" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "step" text,
  "log" text DEFAULT '' NOT NULL,
  "backup_path" text,
  "error" text,
  "requested_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "update_jobs" ADD CONSTRAINT "update_jobs_requested_by_admin_users_id_fk"
    FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "update_jobs_created_idx" ON "update_jobs" USING btree ("created_at");
--> statement-breakpoint
-- 업데이트가 두 개 동시에 돌면 이미지 교체와 마이그레이션이 서로를 덮어쓴다.
-- 끝나지 않은 작업은 언제나 최대 하나.
CREATE UNIQUE INDEX IF NOT EXISTS "update_jobs_one_active_idx" ON "update_jobs" ((1))
  WHERE "status" IN ('pending', 'running');
