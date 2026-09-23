-- 방해금지 시간대를 재는 기준 타임존(IANA). null 이면 UTC — 칼럼이 없던 때와 같은 판정이라
-- 기존 프로젝트의 예약 시각이 마이그레이션만으로 움직이지 않는다.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "timezone" text;
--> statement-breakpoint
-- failed 로 닫은 이유. 일시적 실패는 한도까지 되살리므로, 값이 있다는 건 한도를 다 쓰고 포기했다는 뜻이다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint
-- 익명 전환을 기기 단위로 가르기 위한 값. 기기가 지워져도 과거 성과는 그대로여야 해서 FK 를 걸지 않는다
-- (set null 이면 서로 다른 익명 전환이 같은 키로 뭉쳐 아래 유니크가 깨진다).
ALTER TABLE "push_conversions" ADD COLUMN IF NOT EXISTS "device_id" uuid;
--> statement-breakpoint
-- 익명(user_id null) 기기를 상수 하나로 coalesce 하던 유니크를 교체한다. 그대로 두면 한 발송에서
-- 익명 기기 전체의 전환이 (발송, 이름, 날짜) 하루 1건으로 합쳐져 익명 비중이 큰 앱의 매출이 사라진다.
-- 주체 = 사람이 있으면 사람, 없으면 그 기기, 둘 다 없으면(과거 행) 예전과 같은 단일 키.
DROP INDEX IF EXISTS "push_conversions_uniq_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_conversions_uniq_idx" ON "push_conversions" (
	"log_id",
	"name",
	(("created_at" at time zone 'utc')::date),
	(coalesce('u:' || "user_id"::text, 'd:' || "device_id"::text, 'anon'))
);
--> statement-breakpoint
-- 재시도 스윕은 status in ('failed','retrying') 를 본다. 0024 의 부분 인덱스는 'failed' 만 담아
-- retrying 행이 섞인 질의를 덮지 못한다 — 조건을 스윕 질의와 정확히 맞춘 인덱스로 갈아 끼운다.
DROP INDEX IF EXISTS "webhook_deliveries_retry_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_sweep_idx"
	ON "webhook_deliveries" ("next_attempt_at", "attempts")
	WHERE "status" in ('failed','retrying');
