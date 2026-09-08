import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "./card";
import { cn } from "@/lib/utils";

export type StatTileAccent = "default" | "primary" | "success" | "warning" | "muted";

const accentClass: Record<StatTileAccent, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/** goji/webapp StatTile — 라벨 + 아이콘 배지 + 큰 수치 + 힌트 */
export function StatTile({
  label,
  value,
  icon: Icon,
  hint,
  accent = "default",
  suffix,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  hint?: string | null;
  accent?: StatTileAccent;
  suffix?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[12px] font-semibold text-muted-foreground" title={label}>
            {label}
          </p>
          {Icon && (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
              <Icon aria-hidden="true" className="h-3.5 w-3.5 text-primary" strokeWidth={2.25} />
            </div>
          )}
        </div>
        <p className={cn("mt-2 truncate text-2xl font-extrabold tracking-tight tabular-nums", accentClass[accent])}>
          {value}
          {suffix && <span className="ml-1 text-[12px] font-bold text-muted-foreground">{suffix}</span>}
        </p>
        <p className={cn("mt-1 truncate text-[11px] text-muted-foreground", hint ? "" : "invisible")}>{hint || "\u00b7"}</p>
      </CardContent>
    </Card>
  );
}
