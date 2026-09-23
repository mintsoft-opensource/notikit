"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CSS 그리드로 그린 표에 표 의미를 붙인다.
 *
 * `<table>` 대신 그리드를 쓰는 이유는 좁은 화면에서 행을 세로로 쌓기 위해서다.
 * 그런데 div/span 만으로 두면 스크린리더에는 **라벨 없는 목록**으로 읽힌다 —
 * 어느 값이 "성공/대상"인지 알 방법이 전혀 없다(WCAG 1.3.1).
 *
 * 그래서 ARIA 표 역할을 명시한다. 역할은 **전부 갖추거나 하나도 안 붙이거나**여야
 * 한다 — 일부만 붙이면 표 구조가 깨진 것으로 읽혀 안 붙인 것보다 나쁘다.
 *
 * 셀에 `aria-label` 을 붙이지 않는다 — 스크린리더가 값 대신 열 이름("성공")만 읽어
 * 정작 숫자를 들을 수 없게 된다. 열 이름은 `columnheader` 가 제공하고, 셀의 이름은 값이다.
 */
export type Column = {
  /** 헤더에 보일 이름 */
  label: string;
  /** 우측 정렬(숫자·시각 열) */
  align?: "end";
  /** 헤더 칸을 비운다(액션 버튼 열 등) */
  blank?: boolean;
};

const HEADER =
  "hidden gap-x-4 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground";

export function TableHeader({
  columns,
  grid,
  show = "xl",
  className,
}: {
  columns: Column[];
  /** 행과 **동일한** grid-cols 유틸리티. 다르면 열이 어긋난다. */
  grid: string;
  /** 헤더가 보이기 시작하는 브레이크포인트 — 행이 가로로 펴지는 지점과 맞춘다 */
  show?: "sm" | "lg" | "xl";
  className?: string;
}) {
  const at = { sm: "sm:grid", lg: "lg:grid", xl: "xl:grid" }[show];
  return (
    <div role="rowgroup">
      <div role="row" data-header-show={show} className={cn(HEADER, grid, at, className)}>
        {columns.map((c, i) =>
          c.blank ? (
            <span key={i} role="columnheader" aria-label="" />
          ) : (
            <span key={i} role="columnheader" className={c.align === "end" ? "text-end" : undefined}>
              {c.label}
            </span>
          )
        )}
      </div>
    </div>
  );
}

/** 행 묶음. `<ul>` 대신 role 을 쓴다 — 목록과 표가 겹쳐 읽히면 안 된다. */
export function TableBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="rowgroup" className={cn("divide-y divide-border", className)}>
      {children}
    </div>
  );
}

export function TableRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="row" className={className}>
      {children}
    </div>
  );
}

/**
 * 셀. `label` 은 열 이름이다. 접근 가능한 이름으로 쓰지 않고(값이 이름이어야 한다)
 * `data-label` 로만 남긴다. 헤더가 숨는 좁은 화면에서는 globals.css 가 이 값을 셀 위에 보이는
 * 라벨로 그린다(가상 요소라 접근 가능한 이름에 섞이지 않는다).
 */
export function TableCell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="cell" data-label={label} className={className}>
      {children}
    </div>
  );
}

/** 표 전체를 감싼다. 행 수를 알리면 스크린리더가 "N 중 M" 을 읽어준다. */
export function DataTable({
  label,
  rowCount,
  children,
  className,
}: {
  label: string;
  /** 헤더를 포함한 행 수 */
  rowCount: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="table" aria-label={label} aria-rowcount={rowCount} className={className}>
      {children}
    </div>
  );
}
