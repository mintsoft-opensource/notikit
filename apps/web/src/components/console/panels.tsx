"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import { cn } from "@/lib/utils";

export { StatTile } from "@/components/ui/stat-tile";
export { EmptyState } from "@/components/ui/empty-state";
export { DataRow } from "@/components/ui/data-row";
export { Segmented } from "@/components/ui/segmented";

export function formatDuration(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

/** 섹션 구분 — 라벨 + 우측 보조 정보 */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-bold tracking-tight text-foreground">{children}</h2>
      {right}
    </div>
  );
}

/** 수평 바 목록 — 단일 측정값, 값 라벨 병기 */
export function BarList({ rows, className }: { rows: Array<{ label: string; value: number; color?: string }>; className?: string }) {
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={cn("space-y-3", className)}>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--chart-1)", minWidth: r.value > 0 ? "4px" : 0 }}
            />
          </span>
          <span className="w-12 shrink-0 text-right text-xs font-bold tabular-nums">{nf.format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
