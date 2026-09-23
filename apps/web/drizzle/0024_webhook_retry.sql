-- 실패한 배달을 지수 백오프로 다시 보내려면 "다음에 언제 시도할지"가 행에 있어야 한다.
-- null 은 "아직 예약되지 않음" — 기존 실패 행도 스윕이 바로 집어 간다.
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
-- 스윕 질의(status='failed' AND attempts < 5 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))용.
-- 실패 행만 담는 부분 인덱스라, 배달 이력이 쌓여도 스윕이 훑는 범위가 늘지 않는다.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_retry_idx"
	ON "webhook_deliveries" ("next_attempt_at", "attempts")
	WHERE "status" = 'failed';
