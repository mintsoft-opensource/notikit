"use client";

import { cn } from "@/lib/utils";

/** goji/webapp Segmented — 필터/기간 선택 (탭이 아니므로 radiogroup) */
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
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex rounded-lg bg-surface-muted p-0.5 text-[13px] font-semibold", className)}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          aria-label={opt.srLabel}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-[7px] px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            value === opt.value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
