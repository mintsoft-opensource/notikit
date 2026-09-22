-- 다중 발송(type='multi')의 받는 사람 목록. 사용자 아이디(external_id) 배열이다.
-- target(text) 한 칸에 이어 붙이지 않는 이유: 아이디에 구분자가 들어올 수 있고,
-- 클릭 자격 검사가 "이 사람이 목록에 있었나"를 정확히 물어야 한다.
ALTER TABLE "push_logs" ADD COLUMN IF NOT EXISTS "targets" jsonb;
