import os from "node:os";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const execFileAsync = promisify(execFile);

export type HostMetrics = {
  cpu: { usagePct: number | null; loadavg: [number, number, number]; cores: number };
  memory: { totalBytes: number; usedBytes: number; processRssBytes: number; heapUsedBytes: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
  eventLoop: { p50Ms: number; p99Ms: number } | null;
  uptimeSec: number;
  processUptimeSec: number;
  platform: string;
};

/**
 * 델타 기반 지표(CPU/네트워크/이벤트루프)는 "직전 샘플"이라는 공유 상태를 갖는다.
 * 요청 핸들러가 직접 샘플링하면 동시 요청끼리 서로의 직전 값을 덮어써
 * 델타 구간이 0 으로 수렴하고(허위 100% CPU), 히스토그램 리셋이 서로를 지운다.
 * → 샘플링은 단일 백그라운드 타이머만 수행하고, 요청은 스냅샷을 읽기만 한다.
 */
const SAMPLE_MS = 2000;
const STALE_MS = 30_000;

type CpuSample = { idle: number; total: number };
type NetSample = { rx: number; tx: number; at: number };

let prevCpu: CpuSample | null = null;
let prevNet: NetSample | null = null;
let loopHist: IntervalHistogram | null = null;

let snapshot: { metrics: HostMetrics; at: number } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const v of Object.values(c.times)) total += v;
  }
  return { idle, total };
}

function cpuUsagePct(): number | null {
  const now = cpuSample();
  const base = prevCpu;
  prevCpu = now;
  if (!base) return null; // 첫 샘플은 델타 구간이 없음
  const dTotal = now.total - base.total;
  if (dTotal <= 0) return null;
  return Math.min(100, Math.max(0, (1 - (now.idle - base.idle) / dTotal) * 100));
}

async function netTotals(): Promise<{ rx: number; tx: number } | null> {
  try {
    if (process.platform === "linux") {
      // /proc/net/dev: iface: rxBytes ... (9번째 필드부터 tx) — lo 제외
      let rx = 0;
      let tx = 0;
      for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
        const m = line.trim().match(/^([^:]+):\s*(.+)$/);
        if (!m || m[1].trim() === "lo") continue;
        const f = m[2].trim().split(/\s+/);
        rx += Number(f[0]) || 0;
        tx += Number(f[8]) || 0;
      }
      return { rx, tx };
    }
    if (process.platform === "darwin") {
      // netstat -ibn: Name ... Ibytes ... Obytes — 인터페이스별 첫 행만, lo0 제외
      const { stdout } = await execFileAsync("/usr/sbin/netstat", ["-ibn"], { timeout: 3000 });
      const lines = stdout.split("\n");
      const header = lines[0]?.trim().split(/\s+/) ?? [];
      const iIb = header.indexOf("Ibytes");
      const iOb = header.indexOf("Obytes");
      if (iIb < 0 || iOb < 0) return null;
      const seen = new Set<string>();
      let rx = 0;
      let tx = 0;
      for (const line of lines.slice(1)) {
        const f = line.trim().split(/\s+/);
        const name = f[0];
        if (!name || name === "lo0" || seen.has(name) || f.length <= Math.max(iIb, iOb)) continue;
        seen.add(name);
        rx += Number(f[iIb]) || 0;
        tx += Number(f[iOb]) || 0;
      }
      return { rx, tx };
    }
  } catch {
    return null;
  }
  return null;
}

async function netRate(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number } | null> {
  const totals = await netTotals();
  if (!totals) return null;
  const now: NetSample = { ...totals, at: Date.now() };
  const base = prevNet;
  prevNet = now;
  // 첫 샘플이거나 간격이 비정상(<200ms, 카운터 리셋 등)이면 값 폭발을 막기 위해 건너뜀
  if (!base || now.at - base.at < 200 || now.rx < base.rx || now.tx < base.tx) return null;
  const sec = (now.at - base.at) / 1000;
  return { rxBytesPerSec: (now.rx - base.rx) / sec, txBytesPerSec: (now.tx - base.tx) / sec };
}

/** 이벤트루프 지연 — 샘플러만 읽고 리셋하므로 구간이 다른 호출자에게 잘리지 않는다 */
function eventLoopStats(): { p50Ms: number; p99Ms: number } | null {
  if (!loopHist) {
    loopHist = monitorEventLoopDelay({ resolution: 20 });
    loopHist.enable();
    return null;
  }
  const stats = { p50Ms: loopHist.percentile(50) / 1e6, p99Ms: loopHist.percentile(99) / 1e6 };
  loopHist.reset();
  return stats;
}

async function sampleOnce(): Promise<void> {
  // 콜드 스타트에 동시 요청이 몰려도 샘플링은 1회만 — 나머지는 같은 Promise 를 기다린다
  if (inflight) return inflight;
  inflight = (async () => {
    const usagePct = cpuUsagePct();
    const network = await netRate();
    const mem = process.memoryUsage();
    snapshot = {
      at: Date.now(),
      metrics: {
        cpu: { usagePct, loadavg: os.loadavg() as [number, number, number], cores: os.cpus().length },
        memory: {
          totalBytes: os.totalmem(),
          usedBytes: os.totalmem() - os.freemem(),
          processRssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
        },
        network,
        eventLoop: eventLoopStats(),
        uptimeSec: os.uptime(),
        processUptimeSec: process.uptime(),
        platform: process.platform,
      },
    };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function ensureSampler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sampleOnce();
  }, SAMPLE_MS);
  timer.unref?.(); // 샘플러가 프로세스 종료를 막지 않도록
}

/** 최신 스냅샷 반환 — 요청 경로는 공유 상태를 변경하지 않는다 */
export async function collectHostMetrics(): Promise<HostMetrics> {
  ensureSampler();
  // 콜드 스타트: 첫 샘플(델타 없음) + 한 구간 뒤 실측값을 얻기 위해 2회
  if (!snapshot) {
    await sampleOnce();
    await new Promise((r) => setTimeout(r, 250)); // 네트워크 델타 최소 간격(200ms) 이상
    await sampleOnce();
  } else if (Date.now() - snapshot.at > STALE_MS) {
    await sampleOnce();
  }
  return snapshot!.metrics;
}
