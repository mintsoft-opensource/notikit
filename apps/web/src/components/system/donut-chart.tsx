"use client";

import * as React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export type DonutSlice = { label: string; value: number; color: string };

/**
 * 도넛 차트 — 구성비 하나를 보여줄 때만.
 *
 * recharts 는 텍스트 대안을 만들어주지 않으므로 sr-only 표를 함께 낸다(라인 차트와 동일).
 * 색만으로 구분되지 않도록 범례에 라벨과 수치를 항상 같이 적는다.
 */
export function DonutChart({
  label,
  slices,
  height = 200,
  formatValue,
}: {
  /** role="img" 의 접근 가능한 이름 — 필수 */
  label: string;
  slices: DonutSlice[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const fmt = formatValue ?? ((v: number) => String(v));
  // 분모가 0이면 비율은 정의되지 않는다 — 0% 로 위장하지 않는다
  const pct = (v: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "—");

  if (total === 0) return null;

  return (
    <div>
      <div role="img" aria-label={label} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="86%"
              // 조각 사이 간격 — 인접 색이 붙어 보이지 않게
              paddingAngle={2}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.label} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-tile)",
                fontSize: "var(--text-xs)",
              }}
              formatter={(v, name) => {
                const n = typeof v === "number" ? v : Number(v ?? 0);
                return [`${fmt(n)} (${pct(n)})`, String(name ?? "")];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-3 space-y-1.5">
        {slices.map((s) => (
          <li key={s.label} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 text-xs">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="truncate text-muted-foreground">{s.label}</span>
            <span className="tabular-nums font-semibold">{fmt(s.value)}</span>
            <span className="w-12 text-right tabular-nums text-muted-foreground">{pct(s.value)}</span>
          </li>
        ))}
      </ul>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">value</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.label}>
              <th scope="row">{s.label}</th>
              <td>{fmt(s.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
