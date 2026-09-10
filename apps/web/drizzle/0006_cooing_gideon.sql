ALTER TABLE "push_clicks" DROP CONSTRAINT "push_clicks_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "push_clicks" ALTER COLUMN "device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "push_logs" ADD COLUMN "audience_device_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_clicks" ADD CONSTRAINT "push_clicks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;