-- segments 테이블 제거. 0015 이관을 검증한 뒤 저널에 넣었다.
--
-- 검증 기준(적용 시점에 dev/e2e 모두 통과):
--   - segments_migration_conflicts 가 0건
--   - 규칙이 있는 segments 중 같은 이름의 규칙식 topics 가 없는 것이 0건
--
-- 되돌릴 수 없다. segments 행이 사라진다.
--
-- 0015 와 같은 기동에서 자동 적용된다. 마이그레이터는 한 트랜잭션으로 돌므로 여기서
-- 멈추면 0015 도 롤백되어 원본이 그대로 남는다. 겹친 이름을 메시지에 담아 둔다 —
-- 해당 토픽이나 세그먼트 이름을 바꾼 뒤 다시 기동하면 진행된다.
DO $$
DECLARE
  conflicts text;
BEGIN
  IF to_regclass('public.segments_migration_conflicts') IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(project_id::text || '/' || name, ', ') INTO conflicts
    FROM "segments_migration_conflicts";
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'segment/topic name conflicts (project/name): % — rename them before dropping segments', conflicts;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "segments";
--> statement-breakpoint
DROP TABLE IF EXISTS "segments_migration_conflicts";
