"use client";

import * as React from "react";

export type LiveSeries = { key: string; label: string; color: string; values: Array<number | null> };

/** 컨테이너 실측 폭 — SVG 를 실제 픽셀 좌표로 그려 글자 크기를 보존 */
function useMeasuredWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(fallback);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setW(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * 실측 폭 라인/영역 차트 — 다중 시리즈(2개 이상이면 범례), 크로스헤어 툴팁, null 구간 끊김.
 * times[i] ↔ 각 시리즈 values[i].
 */
export function LiveChart({
  times,
  series,
  maxY,
  formatY,
  formatTime,
  height = 190,
  area = false,
}: {
  times: number[];
  series: LiveSeries[];
  maxY?: number;
  formatY: (v: number) => string;
  formatTime: (t: number) => string;
  height?: number;
  area?: boolean;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const [boxRef, W] = useMeasuredWidth<HTMLDivElement>();
  const svgRef = React.useRef<SVGSVGElement>(null);
  const H = height, L = 62, R = 8, T = 12, B = 24;
  const iw = Math.max(40, W - L - R), ih = H - T - B;
  const dataMax = Math.max(1e-9, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)));
  const yMax = maxY ?? dataMax * 1.2;
  const n = times.length;
  const x = (i: number) => L + (n <= 1 ? iw : (i / (n - 1)) * iw);
  const y = (v: number) => T + ih - (Math.min(v, yMax) / yMax) * ih;

  function linePath(values: Array<number | null>): string {
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

  function areaPath(values: Array<number | null>): string {
    // 단일 연속 구간 가정의 단순 영역 (null 은 0 취급하지 않고 스킵)
    const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)] as const));
    const solid = pts.filter((p): p is readonly [number, number] => p !== null);
    if (solid.length < 2) return "";
    return (
      `M${solid[0][0].toFixed(1)},${(T + ih).toFixed(1)}` +
      solid.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join("") +
      `L${solid[solid.length - 1][0].toFixed(1)},${(T + ih).toFixed(1)}Z`
    );
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left - L) / iw) * (n - 1)))));
  }

  // 라벨이 중복되는 눈금(작은 정수 범위 반올림 등)은 제거
  const ticks = [0, yMax / 2, yMax].filter((tv, i, arr) => arr.findIndex((o) => formatY(o) === formatY(tv)) === i);

  return (
    <div ref={boxRef}>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-4">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <svg ref={svgRef} width={W} height={H} className="block" role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={L} x2={W - R} y1={y(tv)} y2={y(tv)} stroke="var(--border)" strokeWidth="1" />
              <text x={L - 8} y={y(tv) + 3.5} textAnchor="end" fontSize="11" fill="var(--muted-foreground)" className="tabular-nums">
                {formatY(tv)}
              </text>
            </g>
          ))}
          {n > 1 &&
            [0, Math.floor((n - 1) / 2), n - 1].map((i) => (
              <text
                key={i}
                x={x(i)}
                y={H - 7}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize="11"
                fill="var(--muted-foreground)"
              >
                {formatTime(times[i])}
              </text>
            ))}
          {area &&
            series.map((s) => <path key={`a-${s.key}`} d={areaPath(s.values)} fill={s.color} opacity="0.1" />)}
          {series.map((s) => (
            <path key={s.key} d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
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
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: x(hover), transform: `translateX(${hover > n / 2 ? "calc(-100% - 10px)" : "10px"})` }}
          >
            <p className="whitespace-nowrap text-muted-foreground">{formatTime(times[hover])}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap font-semibold tabular-nums">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                {series.length > 1 ? `${s.label}: ` : ""}
                {s.values[hover] != null ? formatY(s.values[hover]!) : "—"}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** bytes → 사람이 읽는 단위 */
export function formatBytes(v: number): string {
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${Math.round(v)} B`;
}
