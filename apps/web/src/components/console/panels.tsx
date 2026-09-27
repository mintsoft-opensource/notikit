"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/number-format";

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
  const nf = useNumberFormat();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={cn("space-y-4", className)}>
      {rows.map((r) => (
        // 라벨은 고정 w-24(96px) 로 두면 "Netherlands" 같은 이름이 잘리고, 값은 w-12 로
        // 두면 여섯 자리(100,000)가 넘친다. 라벨은 9rem 까지 늘었다 줄고, 값 칸은 내용
        // 너비(auto)로 잡아 자릿수가 늘어도 막대만 짧아지게 한다.
        <div key={r.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3">
          <span className="truncate text-xs text-muted-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--chart-1)", minWidth: r.value > 0 ? "4px" : 0 }}
            />
          </span>
          <span className="text-end text-xs font-bold tabular-nums">{nf.format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
