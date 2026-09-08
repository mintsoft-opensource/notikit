import * as React from "react";
import { cn } from "@/lib/utils";

/** goji/webapp DataRow — 라벨 좌측 muted, 값 우측 bold */
export function DataRow({
  label,
  value,
  mono,
  compact,
  tone = "default",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  compact?: boolean;
  tone?: "default" | "danger" | "warning" | "muted" | "primary";
  className?: string;
}) {
  const valueColor = {
    default: "text-foreground",
    danger: "text-error",
    warning: "text-warning",
    muted: "text-muted-foreground",
    primary: "text-primary",
  }[tone];
  return (
    <div className={cn("flex items-start justify-between gap-3", compact ? "text-xs" : "text-sm", className)}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("text-right font-semibold", valueColor, mono && "font-mono tabular-nums")}>{value}</dd>
    </div>
  );
}
