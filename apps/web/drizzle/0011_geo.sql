CREATE TABLE "countries" (
	"code" text PRIMARY KEY NOT NULL,
	"name_ko" text NOT NULL,
	"name_en" text NOT NULL,
	"region" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_country_ranges" (
	"start_ip" "inet" NOT NULL,
	"end_ip" "inet" NOT NULL,
	"family" integer NOT NULL,
	"country_code" text NOT NULL,
	CONSTRAINT "ip_country_ranges_family_start_ip_pk" PRIMARY KEY("family","start_ip")
);
--> statement-breakpoint
CREATE INDEX "ip_country_lookup_idx" ON "ip_country_ranges" USING btree ("family","start_ip");