import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./focus-ring";

const buttonVariants = cva(
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors ${FOCUS_RING} disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0`,
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "bg-accent-soft text-primary hover:bg-accent-soft/70",
        outline:
          "border border-border bg-surface text-foreground shadow-sm hover:bg-surface-muted",
        ghost: "hover:bg-surface-muted text-foreground",
        destructive: "bg-error text-error-foreground hover:opacity-90",
      },
      // 컨트롤 높이는 하나(36px)로 통일한다 — 입력칸·선택 상자·날짜 선택과 한 줄에 놓여도 어긋나지 않게.
      // sm 은 좌우 여백만 줄인다(표 안의 행 동작처럼 폭이 좁은 곳).
      size: {
        default: "h-9 px-3.5",
        sm: "h-9 px-3",
        lg: "h-10 px-4 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { buttonVariants };
