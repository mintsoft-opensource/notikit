"use client";

import * as React from "react";
import { STAT_TILE_GRID, statTileSpan } from "./stat-tile-grid";
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

/**
 * KPI 타일 줄. **마지막 줄에 타일 하나만 남지 않게** 칸 수를 맞춘다 —
 * 5개 타일을 2·3열에 그냥 흘리면 마지막 한 개가 줄 왼쪽에 덩그러니 남아 리듬이 깨진다.
 *
 * 2열에서는 홀수 마지막 타일이 가로 전체를, 3열(md, 6칸 격자에 2칸씩)에서는 마지막 줄의
 * 두 타일이 절반씩 나눠 갖는다. 5열(xl)은 5개가 정확히 한 줄이라 그대로 둔다.
 */
export { STAT_TILE_GRID, statTileSpan } from "./stat-tile-grid";

export function StatTileGrid({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children);
  return (
    <div className={STAT_TILE_GRID}>
      {items.map((child, i) => (
        // 감싼 칸이 줄 높이를 받고 타일이 그 높이를 채운다 — 힌트 줄이 있고 없고에 따라 키가 달라지지 않게
        <div key={i} className={cn("min-w-0 [&>*]:h-full", statTileSpan(i, items.length))}>
          {child}
        </div>
      ))}
    </div>
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
          // 값은 자르지 않는다 — 200~400% 확대에서 고정폭으로 자르면 수치 자체가 사라진다
          <p className={cn("mt-2 break-words text-xl font-extrabold tracking-tight tabular-nums", accentClass[accent])}>
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
