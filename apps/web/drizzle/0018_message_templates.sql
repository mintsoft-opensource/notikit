-- 메시지 템플릿 — 제목·본문·딥링크와 커스텀 필드(푸시 data) 정의를 묶어 둔다.
-- 콘솔 편의 기능이라 발송 로그는 템플릿을 참조하지 않는다(지워도 과거 발송이 흔들리지 않는다).
CREATE TABLE IF NOT EXISTS "message_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "deep_link" text,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_templates_name_idx" ON "message_templates" ("project_id", "name");
