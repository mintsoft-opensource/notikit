CREATE TABLE "geo_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"countries" integer DEFAULT 0 NOT NULL,
	"ipv4" integer DEFAULT 0 NOT NULL,
	"ipv6" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "geo_imports_started_idx" ON "geo_imports" USING btree ("started_at");