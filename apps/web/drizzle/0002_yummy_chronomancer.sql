CREATE TABLE "system_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_pct" double precision,
	"loadavg_1" double precision,
	"mem_used_bytes" bigint,
	"mem_total_bytes" bigint,
	"rss_bytes" bigint,
	"heap_bytes" bigint,
	"net_rx_bps" double precision,
	"net_tx_bps" double precision,
	"loop_p50_ms" double precision,
	"loop_p99_ms" double precision
);
--> statement-breakpoint
CREATE INDEX "system_metrics_at_idx" ON "system_metrics" USING btree ("at");--> statement-breakpoint
CREATE INDEX "system_metrics_instance_idx" ON "system_metrics" USING btree ("instance_id","at");