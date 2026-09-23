-- 발송 신뢰성·성능 묶음.
--
-- 1) 활성 기기 keyset 페이지 인덱스. 발송·도달 인원 집계가 (project_id, id) 순서로
--    활성 기기만 훑는다. 비활성 기기가 쌓여도 인덱스가 커지지 않게 부분 인덱스로 둔다.
CREATE INDEX IF NOT EXISTS "devices_active_page_idx" ON "devices" ("project_id", "id") WHERE "is_active";
--> statement-breakpoint
-- 2) 재클레임 시 이어서 보낼 지점(JSON: 커서·누적 카운터·분모 스냅샷).
--    없으면 워커가 죽을 때마다 처음부터 다시 보내 앞쪽 수신자가 중복 수신한다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "resume_cursor" text;
--> statement-breakpoint
-- 3) 멱등 키 — 네트워크 재시도가 같은 발송을 두 번 큐잉하지 않게. 키가 없는 발송이
--    대부분이라 부분 유니크로 둔다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_logs_idempotency_idx" ON "push_logs" ("project_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- 4) 발송자 — 콘솔이면 멤버 이메일, SDK/서버 키면 "api", 저니면 "journey".
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "sent_by" text;
--> statement-breakpoint
-- 5) 빈도 상한 — 사용자 한 명이 24시간 동안 받을 수 있는 (테스트 제외) 푸시 수. null 이면 제한 없음.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "frequency_cap_per_day" integer;
--> statement-breakpoint
-- 빈도 상한 판정 근거 — 사용자별 수신 기록. 발송 로그만으로는 broadcast·토픽 발송의
-- 실제 수신자를 알 수 없다. 상한이 켜진 프로젝트에서만 쌓이고 25시간이 지나면 지운다.
CREATE TABLE IF NOT EXISTS "push_user_sends" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "push_users"("id") ON DELETE CASCADE,
  "log_id" uuid NOT NULL REFERENCES "push_logs"("id") ON DELETE CASCADE,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "push_user_sends_pk" PRIMARY KEY ("log_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_user_sends_user_idx" ON "push_user_sends" ("user_id", "sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_user_sends_project_idx" ON "push_user_sends" ("project_id", "sent_at");
