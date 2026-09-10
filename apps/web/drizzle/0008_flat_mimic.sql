CREATE TABLE "device_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid,
	"platform" text,
	"day" date NOT NULL,
	"opens" integer DEFAULT 1 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_activity" ADD CONSTRAINT "device_activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_activity" ADD CONSTRAINT "device_activity_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_activity" ADD CONSTRAINT "device_activity_user_id_push_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."push_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_activity_uniq_idx" ON "device_activity" USING btree ("device_id","day");--> statement-breakpoint
CREATE INDEX "device_activity_day_idx" ON "device_activity" USING btree ("project_id","day");