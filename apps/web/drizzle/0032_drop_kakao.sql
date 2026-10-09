-- 카카오 알림톡 폴백을 제품에서 뺐다. 코드가 더는 읽지 않는 컬럼을 지운다.
--
-- kakao_config_enc 는 암호화된 BSP 자격증명이다 — 설정 화면이 사라지면 지울 길도 없어지므로 남겨 두지 않는다.
ALTER TABLE "projects" DROP COLUMN IF EXISTS "kakao_config_enc";
--> statement-breakpoint
ALTER TABLE "push_logs" DROP COLUMN IF EXISTS "kakao_fallback";
--> statement-breakpoint
ALTER TABLE "push_logs" DROP COLUMN IF EXISTS "kakao_count";
