"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./focus-ring";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * goji/webapp Segmented — 필터/기간 선택 (탭이 아니므로 radiogroup)
 *
 * 라디오 그룹 키보드 규칙(WAI-ARIA APG): Tab 은 그룹에 한 번만 멈추고(선택된 것만 tabIndex 0),
 * 방향키로 선택을 옮긴다. 버튼마다 Tab 이 멈추면 기간 3개를 지나느라 키보드 사용자가 지친다.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: { value: T; label: string; srLabel?: string }[];
  onChange: (value: T) => void;
  className?: string;
  label: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  // 선택값이 목록에 없으면 첫 칸이 Tab 을 받는다 — 그룹 자체에 들어갈 수 없게 되면 안 된다
  const tabbableIndex = selectedIndex === -1 ? 0 : selectedIndex;

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const isNext = NEXT_KEYS.has(e.key);
    if (!isNext && !PREV_KEYS.has(e.key)) return;
    e.preventDefault();
    // RTL 에서 좌우 화살표의 시각적 방향이 뒤집힌다
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const step = (isNext ? 1 : -1) * (rtl && horizontal ? -1 : 1);
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      // 다른 컨트롤과 같은 36px·rounded-lg. 선택 칸이 높이를 다 쓰고 같은 반경을 가지므로
      // 양 끝에서 바깥 모서리와 정확히 겹친다 — overflow-hidden 은 쓰지 않는다.
      // (모서리를 깎으려고 넣으면 칸의 포커스 링 바깥쪽이 잘려 나가 링이 반쪽만 보인다)
      className={cn("inline-flex h-9 items-stretch rounded-lg bg-surface-muted text-sm font-semibold", className)}
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          aria-label={opt.srLabel}
          tabIndex={i === tabbableIndex ? 0 : -1}
          onClick={() => onChange(opt.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
          className={cn(
            "rounded-lg px-3 transition-colors",
            // 칸이 놓인 면은 surface 가 아니라 surface-muted 라 링 오프셋 색만 갈아 끼운다
            FOCUS_RING,
            "focus-visible:ring-offset-surface-muted",
            value === opt.value ? "bg-surface text-foreground shadow-card" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
