"use client";

import * as React from "react";

/**
 * 요일 × 시간 히트맵.
 *
 * recharts 대신 격자 div 로 그린다 — 7×24 칸을 색 하나로 칠하는 데 차트 라이브러리가
 * 필요하지 않고, 각 칸에 title/aria 를 직접 달 수 있다.
 *
 * 색만으로 값을 읽게 두지 않는다: 칸마다 접근 가능한 이름에 숫자를 적고,
 * 스크린 리더용 표를 함께 낸다(도넛/라인 차트와 같은 규칙).
 */
export function Heatmap({
  label,
  /** [요일][시간] = 값. 요일은 0=일요일(Postgres extract(dow) 기준). */
  grid,
  dayLabels,
  cellLabel,
  formatValue,
}: {
  label: string;
  grid: number[][];
  dayLabels: string[];
  /** 칸 하나의 접근 가능한 설명 — "일요일 14시, 12회" 같은 문장을 만든다 */
  cellLabel: (day: string, hour: number, value: number) => string;
  formatValue?: (v: number) => string;
}) {
  const fmt = formatValue ?? ((v: number) => String(v));
  const max = Math.max(0, ...grid.flat());

  /** 0은 칠하지 않는다 — 옅은 색으로 칠하면 "적음"과 "없음"이 구분되지 않는다 */
  const shade = (v: number) => {
    if (v <= 0) return { background: "var(--surface-muted)" };
    // 제곱근 스케일: 한 칸만 튀는 데이터에서 나머지가 전부 빈칸처럼 보이는 것을 막는다
    const t = Math.sqrt(v / max);
    return { background: `color-mix(in oklab, var(--chart-1) ${Math.round(18 + t * 82)}%, transparent)` };
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[34rem]">
          <div className="grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[2px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-2xs tabular-nums text-muted-foreground">
                {h % 3 === 0 ? h : ""}
              </span>
            ))}

            {grid.map((row, d) => (
              <React.Fragment key={d}>
                <span className="flex items-center text-2xs text-muted-foreground">{dayLabels[d]}</span>
                {row.map((v, h) => (
                  <span
                    key={h}
                    role="img"
                    aria-label={cellLabel(dayLabels[d], h, v)}
                    title={cellLabel(dayLabels[d], h, v)}
                    style={shade(v)}
                    className="aspect-square rounded-[3px]"
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, d) => (
            <tr key={d}>
              <th scope="row">{dayLabels[d]}</th>
              {row.map((v, h) => (
                <td key={h}>{fmt(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
