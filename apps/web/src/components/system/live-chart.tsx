"use client";

import * as React from "react";

export type LiveSeries = { key: string; label: string; color: string; values: Array<number | null> };

/**
 * 롤링 버퍼 라이브 라인 차트 — 다중 시리즈(범례 필수), 크로스헤어 툴팁.
 * times[i] ↔ 각 시리즈 values[i]. null 값은 구간 끊김으로 렌더.
 */
export function LiveChart({
  times,
  series,
  maxY,
  formatY,
  formatTime,
  height = 160,
}: {
  times: number[];
  series: LiveSeries[];
  maxY?: number;
  formatY: (v: number) => string;
  formatTime: (t: number) => string;
  height?: number;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const W = 720, H = height, L = 44, R = 10, T = 8, B = 20;
  const iw = W - L - R, ih = H - T - B;
  const dataMax = Math.max(1e-9, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)));
  const yMax = maxY ?? dataMax * 1.15;
  const n = times.length;
  const x = (i: number) => L + (n <= 1 ? iw : (i / (n - 1)) * iw);
  const y = (v: number) => T + ih - (Math.min(v, yMax) / yMax) * ih;

  function path(values: Array<number | null>): string {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / iw) * (n - 1)))));
  }

  const ticks = [0, yMax / 2, yMax];

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={L} x2={W - R} y1={y(tv)} y2={y(tv)} stroke="var(--border)" strokeWidth="1" />
              <text x={L - 6} y={y(tv) + 3} textAnchor="end" fontSize="10" fill="var(--muted-foreground)" className="tabular-nums">
                {formatY(tv)}
              </text>
            </g>
          ))}
          {n > 1 &&
            [0, Math.floor((n - 1) / 2), n - 1].map((i) => (
              <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10" fill="var(--muted-foreground)">
                {formatTime(times[i])}
              </text>
            ))}
          {series.map((s) => (
            <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} stroke="var(--border-strong)" strokeWidth="1" />
              {series.map((s) =>
                s.values[hover] != null ? (
                  <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r="4.5" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                ) : null
              )}
            </g>
          )}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute -top-1 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? "-105%" : "8px"})` }}
          >
            <p className="text-muted-foreground">{formatTime(times[hover])}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 font-semibold tabular-nums">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                {s.label}: {s.values[hover] != null ? formatY(s.values[hover]!) : "—"}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** bytes/sec → 사람이 읽는 단위 */
export function formatBytes(v: number): string {
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}
