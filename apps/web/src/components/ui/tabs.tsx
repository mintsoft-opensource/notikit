"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./focus-ring";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/**
 * 페이지 내 섹션 전환용 탭 (WAI-ARIA tabs 패턴).
 *
 * `Segmented` 와 구분한다 — 그쪽은 필터/기간 선택이라 radiogroup 이고, 이쪽은 콘텐츠
 * 영역을 갈아끼우는 탭이라 tablist/tab/tabpanel 이어야 스크린리더가 "몇 번째 탭,
 * 전체 몇 개"를 읽어준다.
 *
 * 키보드는 roving tabindex — 탭 목록에는 Tab 키로 한 번만 진입하고, 좌우 화살표로
 * 탭 사이를 옮긴다. 모든 탭이 탭 순서에 들어가면 탭이 많을 때 키보드 사용자가
 * 콘텐츠에 도달하기까지 계속 지나가야 한다.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  idPrefix,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: TabItem<T>[];
  /** 탭 목록 자체의 이름 — 스크린리더가 읽는다 */
  label: string;
  /** tab ↔ tabpanel 을 잇는 id 접두사. 한 화면에 탭이 둘 이상이면 달라야 한다 */
  idPrefix: string;
  className?: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: React.KeyboardEvent) {
    const i = items.findIndex((t) => t.value === value);
    if (i < 0) return;
    const last = items.length - 1;
    let n = -1;
    if (e.key === "ArrowRight") n = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") n = i === 0 ? last : i - 1;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = last;
    if (n < 0) return;
    e.preventDefault();
    onChange(items[n].value);
    refs.current[n]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1 border-b border-border", className)}
    >
      {items.map((tab, i) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.value}`}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              // 밑줄이 경계선을 덮도록 -mb-px — 안 그러면 활성 탭 아래 선이 두 겹으로 보인다
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
              FOCUS_RING,
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** 탭 내용. 비활성 패널은 렌더하지 않는다(폼 상태는 부모가 들고 있어야 한다). */
export function TabPanel({
  value,
  idPrefix,
  children,
  className,
}: {
  value: string;
  idPrefix: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${value}`}
      aria-labelledby={`${idPrefix}-tab-${value}`}
      tabIndex={0}
      className={cn("focus-visible:outline-none", className)}
    >
      {children}
    </div>
  );
}
