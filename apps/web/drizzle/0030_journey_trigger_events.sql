-- 이벤트 한 건이 들어올 때마다 프로젝트의 저니를 전부 읽어 JS 에서 진입·종료 이벤트를 걸러냈다.
-- steps 에서 파생한 이벤트 이름을 배열로 두고 GIN 으로 `@>` 를 태워 걸린 저니만 읽는다.
-- 기존 행은 null 로 남긴다(트리를 SQL 로 되짚지 않는다) — 조회가 null 을 함께 읽고 그 자리에서 채운다.
ALTER TABLE "journeys" ADD COLUMN IF NOT EXISTS "trigger_events" text[];
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journeys_trigger_events_idx" ON "journeys" USING gin ("trigger_events");
