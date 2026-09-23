-- 억제 제외(NOT EXISTS)가 발송 페이지·도달 인원 집계마다 돈다. 프로젝트 인덱스만으로는
-- 억제 목록 전체를 훑게 되어, 토큰·external_id 로 바로 찾는 부분 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS "suppressions_project_token_idx" ON "suppressions" ("project_id", "token") WHERE "token" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppressions_project_external_idx" ON "suppressions" ("project_id", "external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
-- 발송 후속 단계(인박스)를 재클레임 때 다시 돌려도 같은 사람에게 두 번 쌓이지 않게 발송 로그를 남긴다.
-- 로그가 리텐션으로 지워져도 인박스 항목은 남아야 하므로 SET NULL.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "log_id" uuid REFERENCES "push_logs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_log_user_idx" ON "notifications" ("log_id", "user_id") WHERE "log_id" IS NOT NULL;
