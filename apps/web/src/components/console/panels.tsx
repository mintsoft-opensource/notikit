"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";

export function formatDuration(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

/** 섹션 타이틀 — 라벨 + 구분선 (그라파나 row) */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2 className="shrink-0 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{children}</h2>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {right}
    </div>
  );
}

/** 셀 배경 스파크라인 — 축 없는 미니 추이 */
export function Spark({ values, max }: { values: Array<number | null>; max?: number }) {
  const solid = values.filter((v): v is number => v != null);
  if (solid.length < 2) return null;
  const yMax = max ?? Math.max(1e-9, ...solid) * 1.1;
  const W = 100, H = 100;
  const pts = values
    .map((v, i) => (v == null ? null : `${((i / (values.length - 1)) * W).toFixed(1)},${(H - (Math.min(v, yMax) / yMax) * H).toFixed(1)}`))
    .filter(Boolean) as string[];
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-9 w-full opacity-[0.18]">
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="var(--chart-1)" />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--chart-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type StatCell = { key: string; label: string; value: React.ReactNode; hint?: string | null; spark?: Array<number | null>; sparkMax?: number };

/** 스탯 스트립 — 하나의 카드 안에 헤어라인으로 분할된 셀들 (개별 카드 남발 방지) */
export function StatStrip({ cells, cols }: { cells: StatCell[]; cols: string }) {
  return (
    <Card className="overflow-hidden">
      <div className={`grid gap-px bg-border ${cols}`}>
        {cells.map((c) => (
          <div key={c.key} className="relative bg-surface px-4 pb-3 pt-3.5">
            {c.spark && <Spark values={c.spark} max={c.sparkMax} />}
            <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={c.label}>
              {c.label}
            </p>
            <p className="relative mt-1 truncate text-xl font-extrabold leading-tight tracking-tight tabular-nums">{c.value}</p>
            <p className={`relative mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground ${c.hint ? "" : "invisible"}`}>{c.hint || "·"}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 차트 패널 */
export function Panel({ title, sub, children, className }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <p className="text-sm font-bold">{title}</p>
          {sub && <p className="shrink-0 text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-9 text-center text-sm text-muted-foreground">{children}</p>;
}

/** 수평 바 목록 */
export function BarList({ rows }: { rows: Array<{ label: string; value: number; color?: string }> }) {
  const nf = new Intl.NumberFormat();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-4 flex-1 overflow-hidden rounded-sm bg-surface-muted">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--chart-1)", minWidth: r.value > 0 ? "3px" : 0 }}
            />
          </span>
          <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">{nf.format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
