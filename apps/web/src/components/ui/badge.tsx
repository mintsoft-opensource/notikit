import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // 높이를 고정한다(h-6/24px). 안 정하면 글자 길이·아이콘 유무에 따라 키가 달라져
  // 같은 줄의 h-6 칩(StatusChip 등) 옆에서 줄이 어긋난다 — py-0.5 는 그 높이를 보장하지 않는다.
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-2xs font-semibold leading-none",
  {
    variants: {
      variant: {
        primary: "bg-accent-soft text-primary",
        neutral: "bg-surface-muted text-muted-foreground",
        success: "bg-success/12 text-success",
        warning: "bg-warning/12 text-warning",
        danger: "bg-error/12 text-error",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
