ALTER TABLE "projects" ADD COLUMN "tokens_check_cursor" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tokens_sweep_lease_at" timestamp with time zone;