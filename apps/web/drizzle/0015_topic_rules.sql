-- 세그먼트를 토픽으로 흡수한다.
--
-- 토픽 = 이름 붙인 수신자 그룹. 채우는 방식만 둘이다.
--   rules IS NULL  → 구독식 (subscriptions 에 명단이 쌓인다)
--   rules 있음      → 규칙식 (명단 없이 발송 시점에 유저 속성으로 뽑는다)
--
-- 이 파일은 컬럼 추가 + 데이터 이관까지만 한다. segments 테이블 삭제는 0016 이다
-- (검증 전에 원본을 지우면 되돌릴 수 없다).
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "rules" jsonb;
--> statement-breakpoint
-- 세그먼트 → 토픽. 이름이 겹치면 기존 토픽이 이깁니다(구독 명단이 이미 있으므로
-- 덮어쓰면 실제 구독자를 규칙으로 갈아치우게 된다). 겹친 건 아래 통계로 드러난다.
INSERT INTO "topics" ("project_id", "name", "rules", "created_at")
SELECT s."project_id", s."name", s."rules", s."created_at"
  FROM "segments" s
 -- 규칙 0개는 "조건 없음 = 전원"이라 규칙식으로 옮기면 실수로 전체 발송이 된다. 안 옮긴다.
 WHERE s."rules" IS NOT NULL AND jsonb_array_length(s."rules") > 0
ON CONFLICT ("project_id", "name") DO NOTHING;
--> statement-breakpoint
-- 이관되지 못한 세그먼트(= 같은 이름 토픽이 이미 있던 것)를 남겨 둔다.
-- 0016 에서 segments 를 지우기 전에 이 테이블을 반드시 확인할 것.
CREATE TABLE IF NOT EXISTS "segments_migration_conflicts" (
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "rules" jsonb NOT NULL,
  "noted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "segments_migration_conflicts" ("project_id", "name", "rules")
SELECT s."project_id", s."name", s."rules"
  FROM "segments" s
  JOIN "topics" t
    ON t."project_id" = s."project_id"
   AND t."name" = s."name"
 WHERE t."rules" IS DISTINCT FROM s."rules";
