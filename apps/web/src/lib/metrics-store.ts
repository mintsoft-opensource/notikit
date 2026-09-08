import os from "node:os";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
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

/** 저장된 시계열 조회 — 포인트가 과하면 균등 샘플링해 내려보낸다 */
export async function readHistory(sinceMs: number, instanceId?: string, maxPoints = 240): Promise<MetricPoint[]> {
  const since = new Date(Date.now() - sinceMs);
  const where = instanceId
    ? and(gte(systemMetrics.at, since), eq(systemMetrics.instanceId, instanceId))
    : gte(systemMetrics.at, since);

  const rows = await getDb()
    .select({
      at: systemMetrics.at,
      cpuPct: systemMetrics.cpuPct,
      memUsedBytes: systemMetrics.memUsedBytes,
      memTotalBytes: systemMetrics.memTotalBytes,
      rssBytes: systemMetrics.rssBytes,
      netRxBps: systemMetrics.netRxBps,
      netTxBps: systemMetrics.netTxBps,
      loopP99Ms: systemMetrics.loopP99Ms,
    })
    .from(systemMetrics)
    .where(where)
    .orderBy(asc(systemMetrics.at))
    .limit(5000);

  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  return rows
    .filter((_, i) => i % step === 0)
    .map((r) => ({
      at: new Date(r.at).toISOString(),
      cpuPct: r.cpuPct,
      memPct: r.memUsedBytes && r.memTotalBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null,
      rssBytes: r.rssBytes,
      netRxBps: r.netRxBps,
      netTxBps: r.netTxBps,
      loopP99Ms: r.loopP99Ms,
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
