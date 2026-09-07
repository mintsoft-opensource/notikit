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

// ── CPU — cpus() 누적 틱의 폴링 간 델타로 사용률 계산 ──
type CpuSample = { idle: number; total: number; at: number };
let prevCpu: CpuSample | null = null;

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const v of Object.values(c.times)) total += v;
  }
  return { idle, total, at: Date.now() };
}

async function cpuUsagePct(): Promise<number | null> {
  let base = prevCpu;
  if (!base || Date.now() - base.at > 5 * 60_000) {
    // 첫 호출(또는 장기 미사용): 짧은 이중 샘플로 즉시 값 제공
    base = cpuSample();
    await new Promise((r) => setTimeout(r, 150));
  }
  const now = cpuSample();
  prevCpu = now;
  const dTotal = now.total - base.total;
  if (dTotal <= 0) return null;
  const dIdle = now.idle - base.idle;
  return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
}

// ── 네트워크 — 인터페이스 누적 바이트의 폴링 간 델타(bytes/sec) ──
type NetSample = { rx: number; tx: number; at: number };
let prevNet: NetSample | null = null;

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
      const { stdout } = await execFileAsync("netstat", ["-ibn"], { timeout: 3000 });
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
  if (!base || now.at - base.at > 5 * 60_000 || now.at <= base.at) return null;
  const sec = (now.at - base.at) / 1000;
  return {
    rxBytesPerSec: Math.max(0, (now.rx - base.rx) / sec),
    txBytesPerSec: Math.max(0, (now.tx - base.tx) / sec),
  };
}

// ── 이벤트루프 지연 — 프로세스 전역 히스토그램, 읽을 때마다 리셋 ──
let loopHist: IntervalHistogram | null = null;
function eventLoopStats(): { p50Ms: number; p99Ms: number } | null {
  if (!loopHist) {
    loopHist = monitorEventLoopDelay({ resolution: 20 });
    loopHist.enable();
    return null; // 첫 호출은 수집 구간이 없음
  }
  const p50 = loopHist.percentile(50) / 1e6;
  const p99 = loopHist.percentile(99) / 1e6;
  loopHist.reset();
  return { p50Ms: p50, p99Ms: p99 };
}

export async function collectHostMetrics(): Promise<HostMetrics> {
  const [usagePct, network] = await Promise.all([cpuUsagePct(), netRate()]);
  const mem = process.memoryUsage();
  return {
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
  };
}
