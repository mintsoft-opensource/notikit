import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold",
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
