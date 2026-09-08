import os from "node:os";
import { desc, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { systemMetrics } from "@/db/schema";
import { collectHostMetrics, startHostSampler } from "@/lib/system-metrics";

/** 인스턴스 식별자 — 다중 인스턴스에서 호스트별 시계열을 분리한다 */
export const INSTANCE_ID = process.env.NOTIKIT_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`;

const PERSIST_MS = Number(process.env.SYSTEM_METRICS_INTERVAL_MS ?? 60_000);
const RETENTION_DAYS = Number(process.env.SYSTEM_METRICS_RETENTION_DAYS ?? 7);
const PURGE_EVERY = 60; // 적재 60회(기본 1시간)마다 1번 정리

let timer: ReturnType<typeof setInterval> | null = null;
let writes = 0;

async function persistOnce(): Promise<void> {
  const m = await collectHostMetrics();
  await getDb()
    .insert(systemMetrics)
    .values({
      instanceId: INSTANCE_ID,
      cpuPct: m.cpu.usagePct,
      loadavg1: m.cpu.loadavg[0],
      memUsedBytes: m.memory.usedBytes,
      memTotalBytes: m.memory.totalBytes,
      rssBytes: m.memory.processRssBytes,
      heapBytes: m.memory.heapUsedBytes,
      netRxBps: m.network?.rxBytesPerSec ?? null,
      netTxBps: m.network?.txBytesPerSec ?? null,
      loopP50Ms: m.eventLoop?.p50Ms ?? null,
      loopP99Ms: m.eventLoop?.p99Ms ?? null,
    });

  if (++writes % PURGE_EVERY === 0 && RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
    await getDb().delete(systemMetrics).where(lt(systemMetrics.at, cutoff));
  }
}

/**
 * 백그라운드 적재 시작 — 서버 부팅 시 1회(instrumentation).
 * 대시보드를 아무도 보지 않아도 계속 쌓이고, 재시작해도 이력이 남는다.
 * SYSTEM_METRICS_INTERVAL_MS=0 이면 비활성.
 */
export function startMetricsPersistence(): void {
  if (timer || PERSIST_MS <= 0) return;
  startHostSampler(); // 델타 지표를 위해 샘플러도 함께 기동
  timer = setInterval(() => {
    void persistOnce().catch(() => {
      /* 적재 실패가 서버를 흔들지 않도록 무시 — 다음 주기에 재시도 */
    });
  }, PERSIST_MS);
  timer.unref?.();
}

export type MetricPoint = {
  at: string;
  cpuPct: number | null;
  memPct: number | null;
  rssBytes: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  loopP99Ms: number | null;
};

/**
 * 저장된 시계열 조회 — 다운샘플링을 SQL 버킷 평균으로 수행한다.
 * JS 에서 limit 후 솎아내면 7일(인스턴스당 1만 행)에서 **최신 구간이 통째로 잘려나간다**.
 * 인스턴스를 섞으면 서로 다른 호스트의 값이 한 선으로 이어져 오해를 부르므로 항상 하나만 본다.
 */
export async function readHistory(sinceMs: number, instanceId: string, bucketSec: number): Promise<MetricPoint[]> {
  // postgres 드라이버는 raw sql 보간에 Date 를 받지 않는다 — ISO 문자열 + 명시 캐스트
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const rows = (await getDb().execute(sql`
    select
      to_timestamp(floor(extract(epoch from at) / ${bucketSec}) * ${bucketSec}) as bucket,
      avg(cpu_pct)                                            as cpu_pct,
      avg(mem_used_bytes::float8 / nullif(mem_total_bytes, 0)) as mem_ratio,
      avg(rss_bytes::float8)                                  as rss_bytes,
      avg(net_rx_bps)                                         as net_rx_bps,
      avg(net_tx_bps)                                         as net_tx_bps,
      max(loop_p99_ms)                                        as loop_p99_ms
    from system_metrics
    where at >= ${sinceIso}::timestamptz and instance_id = ${instanceId}
    group by 1
    order by 1 asc
  `)) as unknown as Array<{
    bucket: string | Date;
    cpu_pct: number | null;
    mem_ratio: number | null;
    rss_bytes: number | null;
    net_rx_bps: number | null;
    net_tx_bps: number | null;
    loop_p99_ms: number | null;
  }>;

  return rows.map((r) => ({
    at: new Date(r.bucket).toISOString(),
    cpuPct: r.cpu_pct,
    memPct: r.mem_ratio == null ? null : r.mem_ratio * 100,
    rssBytes: r.rss_bytes,
    netRxBps: r.net_rx_bps,
    netTxBps: r.net_tx_bps,
    loopP99Ms: r.loop_p99_ms,
  }));
}

/** 적재 중인 인스턴스 목록 (최근 활동 순) */
export async function listInstances(sinceMs = 86400_000): Promise<Array<{ instanceId: string; lastAt: string; samples: number }>> {
  const rows = await getDb()
    .select({
      instanceId: systemMetrics.instanceId,
      lastAt: sql<string>`max(${systemMetrics.at})`,
      samples: sql<number>`count(*)::int`,
    })
    .from(systemMetrics)
    .where(gte(systemMetrics.at, new Date(Date.now() - sinceMs)))
    .groupBy(systemMetrics.instanceId)
    .orderBy(desc(sql`max(${systemMetrics.at})`))
    .limit(50);
  return rows.map((r) => ({ instanceId: r.instanceId, lastAt: new Date(r.lastAt).toISOString(), samples: r.samples }));
}
