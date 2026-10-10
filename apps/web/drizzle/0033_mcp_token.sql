ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "mcp_token_hash" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "mcp_token_created_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_mcp_token_hash_idx" ON "projects" ("mcp_token_hash");
