-- 홀드아웃 리프트를 같은 규칙으로 잰다.
--
-- 대조군 전환은 "발송 뒤 24시간 안에 한 전환"이면 기록되는데, 발송군 전환은 **클릭한 경우에만** 기록됐다.
-- 두 비율이 다른 걸 재서 효과가 있는 캠페인도 리프트가 음수로 나왔다.
--
-- push_holdouts 에 발송군(실제로 보낸 기기)도 남긴다 — held=false. 기존 행은 전부 대조군이므로 기본값 true.
ALTER TABLE "push_holdouts" ADD COLUMN IF NOT EXISTS "held" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- 클릭 없이 "받고 24시간 안에" 한 발송군 전환. 리프트 비교에만 쓰고, 클릭 귀속 전환 지표에는 넣지 않는다.
ALTER TABLE "push_conversions" ADD COLUMN IF NOT EXISTS "exposure" boolean DEFAULT false NOT NULL;
