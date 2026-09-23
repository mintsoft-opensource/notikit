-- 리치 알림 이미지(https URL)와 테스트 발송 표시.
-- is_test 는 기존 발송 전부 false — 지금까지는 테스트 발송이라는 구분이 없었다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "image_url" text;
--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;
