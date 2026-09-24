import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * goji/webapp 디자인 시스템 — 반경 --radius-card, padding 단일 p-3.5 (B2B 밀도).
 *
 * 그림자는 shadow-card 토큰 하나로 받는다. foreground 를 섞어 쓰면 다크 모드에서
 * **밝은** 그림자가 되어 카드가 눌린 것처럼 보인다(깊이가 뒤집힌다).
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-card border border-border bg-surface text-foreground shadow-card", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between gap-2.5 p-3.5 pb-2.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-md font-bold tracking-tight text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-0.5 text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-3.5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-border p-3.5 pt-2.5", className)} {...props} />;
}
