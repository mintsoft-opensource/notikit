"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type LiveSeries = { key: string; label: string; color: string; values: Array<number | null> };

const AXIS = { stroke: "var(--muted-foreground)", fontSize: 11 } as const;

/**
 * 라인/영역 차트 — 다중 시리즈(2개 이상이면 범례), 크로스헤어 툴팁, null 구간 끊김.
 * 렌더링은 recharts 에 위임하고, 스크린리더용 데이터 표만 직접 제공한다.
 */
export function LiveChart({
  times,
  series,
  maxY,
  formatY,
  formatTime,
  height = 190,
  area = false,
  label,
  integerY = false,
}: {
  times: number[];
  series: LiveSeries[];
  maxY?: number;
  formatY: (v: number) => string;
  formatTime: (t: number) => string;
  height?: number;
  area?: boolean;
  /** 접근 가능한 이름 — 차트 컨테이너와 sr-only 데이터 표의 캡션에 쓰인다 */
  label: string;
  /** 카운트처럼 정수만 의미 있는 축 — 소수 눈금이 같은 라벨로 중복되는 것을 막는다 */
  integerY?: boolean;
}) {
  const data = React.useMemo(
    () => times.map((t, i) => Object.fromEntries([["t", t], ...series.map((s) => [s.key, s.values[i]])])),
    [times, series]
  );
  const Chart = area ? AreaChart : LineChart;

  return (
    <div>
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
      <div role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height={height}>
          <Chart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={formatTime}
              tickLine={false}
              axisLine={false}
              minTickGap={48}
              {...AXIS}
            />
            <YAxis
              domain={[0, maxY ?? "auto"]}
              allowDecimals={!integerY}
              tickFormatter={formatY}
              tickLine={false}
              axisLine={false}
              width={68}
              {...AXIS}
            />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              labelFormatter={(t) => formatTime(Number(t))}
              formatter={(v, name) => [formatY(Number(v)), series.find((s) => s.key === name)?.label ?? name]}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--muted-foreground)" }}
            />
            {series.map((s) =>
              area ? (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  stroke={s.color}
                  fill={s.color}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ) : (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              )
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">time</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((t, i) => (
            <tr key={t}>
              <th scope="row">{formatTime(t)}</th>
              {series.map((s) => (
                <td key={s.key}>{s.values[i] != null ? formatY(s.values[i]!) : "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * bytes → 사람이 읽는 단위. 단위 표기와 소수 구분자를 로케일에 맡긴다
 * (하드코딩하면 소수 구분자가 ',' 인 로케일과 비라틴 숫자 로케일에서 어긋남).
 */
export function formatBytes(v: number, locale?: string): string {
  const [value, unit, digits]: [number, string, number] =
    v >= 1024 ** 3
      ? [v / 1024 ** 3, "gigabyte", 1]
      : v >= 1024 ** 2
        ? [v / 1024 ** 2, "megabyte", 1]
        : v >= 1024
          ? [v / 1024, "kilobyte", 0]
          : [v, "byte", 0];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
}
