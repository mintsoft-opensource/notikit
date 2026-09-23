-- 사용자 이름 — 치환 변수 {{name}} 과 콘솔 목록·검색에 쓴다.
-- 지금까지는 attributes.name 에 넣는 관례뿐이라 검색도 표시도 안 됐다. 기존 값은 옮겨 둔다.
ALTER TABLE "push_users" ADD COLUMN IF NOT EXISTS "name" text;
--> statement-breakpoint
UPDATE "push_users"
   SET "name" = left("attributes" ->> 'name', 100)
 WHERE "name" IS NULL
   AND jsonb_typeof("attributes" -> 'name') = 'string'
   AND "attributes" ->> 'name' <> '';
