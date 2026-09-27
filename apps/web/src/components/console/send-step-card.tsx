"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** 작성 단계 카드 — 번호 배지가 채워지면 체크로 바뀌어 어디까지 했는지 한눈에 보인다 */
export function StepCard({
  step,
  title,
  done,
  aside,
  className,
  children,
}: {
  step: number;
  title: string;
  done: boolean;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("send");
  const headingId = React.useId();

  return (
    <Card className={cn("min-w-0", className)}>
      <section aria-labelledby={headingId}>
        <header className="flex min-h-12 items-center gap-2.5 border-b border-border px-3.5 py-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums transition-colors duration-200",
              done ? "bg-primary text-primary-foreground" : "border border-border-strong bg-surface text-muted-foreground"
            )}
          >
            {done ? <Check className="size-4" strokeWidth={2.75} /> : step}
          </span>
          <h2 id={headingId} className="text-sm font-bold tracking-tight text-foreground">
            {title}
            {done && <span className="sr-only"> — {t("stepComplete")}</span>}
          </h2>
          {aside && <div className="ms-auto flex items-center gap-2">{aside}</div>}
        </header>
        <div className="space-y-4 p-3.5">{children}</div>
      </section>
    </Card>
  );
}
