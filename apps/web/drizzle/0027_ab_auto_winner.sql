-- A/B 자동 승자. 표본 발송에는 설정(role:"test" — 표본 %, 판정 대기, 지표)과 판정 결과가,
-- 승자 본발송에는 표식(role:"winner" — 표본 발송 id, 표본 %, 변형 번호)이 들어간다.
-- null 이면 칼럼이 없던 때와 같다(변형만 있고 자동 승자는 쓰지 않는 발송).
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "ab_test" jsonb;
