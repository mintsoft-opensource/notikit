CREATE TABLE "push_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"log_id" uuid NOT NULL,
	"device_id" uuid,
	"user_id" uuid,
	"platform" text,
	"destination" text,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN "audience_user_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN "click_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN "click_user_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_clicks" ADD CONSTRAINT "push_clicks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_clicks" ADD CONSTRAINT "push_clicks_log_id_push_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."push_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_clicks" ADD CONSTRAINT "push_clicks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_clicks" ADD CONSTRAINT "push_clicks_user_id_push_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."push_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_clicks_uniq_idx" ON "push_clicks" USING btree ("log_id","device_id");--> statement-breakpoint
CREATE INDEX "push_clicks_log_idx" ON "push_clicks" USING btree ("log_id");--> statement-breakpoint
CREATE INDEX "push_clicks_user_idx" ON "push_clicks" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "push_clicks_at_idx" ON "push_clicks" USING btree ("project_id","clicked_at");