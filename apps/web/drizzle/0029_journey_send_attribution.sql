-- 저니 스텝별 성과 귀속. `journey_runs.last_send_log_id` 는 분기 판정용 **한 건**이라
-- 지나간 발송을 스텝별로 되짚을 수 없었다 — 그래서 단계 퍼널이 "지금 머문 수"에서 멈춰 있었다.
-- 발송 로그 자체에 "어느 저니의 어느 스텝이 만들었나"를 적으면 발송·클릭·전환이 모두 따라온다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "journey_id" uuid;
--> statement-breakpoint
-- 컴파일된 명령의 트리 경로("0", "1.yes.0"). 프로그램 카운터(정수)가 아니다 —
-- 운영자가 스텝을 고치면 PC 는 다른 명령을 가리키지만 경로는 그 자리를 그대로 가리킨다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "step_path" text;
--> statement-breakpoint
-- 저니를 지워도 발송 이력은 남는다(set null). cascade 로 두면 저니 하나를 지우는 것이
-- 그 저니가 보낸 모든 발송 로그·클릭·전환을 같이 지운다.
DO $$ BEGIN
  ALTER TABLE "push_logs" ADD CONSTRAINT "push_logs_journey_id_journeys_id_fk"
    FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- 상세 화면의 스텝별 집계가 타는 축. journey_id 가 있는 행만 담아 인덱스를 작게 둔다
-- (저니 발송은 전체 로그의 극히 일부다).
CREATE INDEX IF NOT EXISTS "push_logs_journey_idx" ON "push_logs" ("journey_id","step_path") WHERE "journey_id" is not null;
