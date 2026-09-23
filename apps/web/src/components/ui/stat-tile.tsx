"use client";

import type { LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent } from "./card";
import { Skeleton } from "./skeleton";
import { cn } from "@/lib/utils";

export type StatTileAccent = "default" | "primary" | "success" | "warning" | "danger" | "muted";

/** 전기간 대비 변화. value 는 부호 있는 수(+3.2 = 3.2 상승). unit "pt" 는 비율끼리의 차(퍼센트포인트) */
export type StatDelta = {
  value: number;
  unit?: "%" | "pt" | "";
  /** 오르는 게 좋은 지표인지(기본 up). 실패율처럼 내려가야 좋은 지표는 "down" */
  goodWhen?: "up" | "down";
  /** 비교 기준 문구 — 예: "지난 7일 대비". 보이는 글자와 스크린리더 문장 둘 다에 쓴다 */
  label?: string;
};

const accentClass: Record<StatTileAccent, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-error",
  muted: "text-muted-foreground",
};

function DeltaLine({ delta }: { delta: StatDelta }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const unit = delta.unit ?? "%";
  const amount = `${nf.format(Math.abs(delta.value))}${unit === "pt" ? "%p" : unit}`;
  const direction = delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat";
  const isGood = direction !== "flat" && direction === (delta.goodWhen ?? "up");
  const tone = direction === "flat" ? "text-muted-foreground" : isGood ? "text-success" : "text-error";
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "–";
  const sentence =
    direction === "flat"
      ? t("deltaFlat", { label: delta.label ?? "" })
      : t(direction === "up" ? "deltaUp" : "deltaDown", { amount, label: delta.label ?? "" });

  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 text-2xs">
      <span aria-hidden="true" className={cn("shrink-0 font-bold tabular-nums", tone)}>
        {glyph} {direction === "flat" ? "0" : amount}
      </span>
      {delta.label && (
        <span aria-hidden="true" className="truncate text-muted-foreground">
          {delta.label}
        </span>
      )}
      <span className="sr-only">{sentence}</span>
    </p>
  );
}

/** goji/webapp StatTile — 라벨 + 아이콘 배지 + 큰 수치 + 힌트(+ 전기간 대비) */
export function StatTile({
  label,
  value,
  icon: Icon,
  hint,
  accent = "default",
  suffix,
  loading,
  delta,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  hint?: string | null;
  accent?: StatTileAccent;
  suffix?: string;
  /** 로딩 중 — 값 자리에 "…" 를 큰 볼드로 찍지 않고 스켈레톤을 보여준다 */
  loading?: boolean;
  delta?: StatDelta | null;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-semibold text-muted-foreground" title={label}>
            {label}
          </p>
          {Icon && (
            // 보조 아이콘 컨테이너 규칙 — 28px(h-7), 조작 요소는 36px
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
              <Icon aria-hidden="true" className="h-3.5 w-3.5 text-primary" strokeWidth={2.25} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-20" />
        ) : (
          <p className={cn("mt-2 truncate text-xl font-extrabold tracking-tight tabular-nums", accentClass[accent])}>
            {value}
            {suffix && <span className="ms-1 text-xs font-bold text-muted-foreground">{suffix}</span>}
          </p>
        )}
        {!loading && delta && Number.isFinite(delta.value) && <DeltaLine delta={delta} />}
        {hint && <p className="mt-1 truncate text-2xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
