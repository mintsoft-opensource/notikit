"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<string, { chip: string; dot: string }> = {
  queued: { chip: "bg-warning/10 text-warning", dot: "bg-warning" },
  scheduled: { chip: "bg-accent-soft text-primary", dot: "bg-primary" },
  processing: { chip: "bg-warning/10 text-warning", dot: "bg-warning motion-safe:animate-pulse" },
  completed: { chip: "bg-success/10 text-success", dot: "bg-success" },
  logged: { chip: "bg-surface-muted text-muted-foreground", dot: "bg-muted-foreground" },
  failed: { chip: "bg-error/10 text-error", dot: "bg-error" },
  // 취소는 실패가 아니다 — 붉게 칠하면 "터졌다" 로 읽힌다. 멈춘 상태로 중립에 둔다.
  canceled: { chip: "bg-surface-muted text-foreground", dot: "bg-muted-foreground" },
};

/** 발송 상태 칩 — 번역된 이름 + 색 점. 모르는 상태는 원문 그대로 회색으로 */
export function StatusChip({ status }: { status: string }) {
  const t = useTranslations("logs");
  const style = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-2xs font-semibold", style?.chip ?? "bg-surface-muted text-muted-foreground")}>
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", style?.dot ?? "bg-muted-foreground")} />
      {style ? t(`status_${status}` as "status_queued") : status}
    </span>
  );
}

/** 테스트 발송 표시 — 통계를 읽을 때 실제 발송과 섞어 보지 않게 */
export function TestChip() {
  const t = useTranslations("logs");
  return (
    // 칩 높이는 StatusChip 과 같은 24px(h-6) — 한 줄에 나란히 서는데 높이가 다르면 둘 중
    // 하나가 잘못 얹힌 것처럼 보인다
    <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-dashed border-border-strong px-2 text-2xs font-semibold text-muted-foreground">
      {t("testChip")}
    </span>
  );
}

/**
 * 비율 미니 막대 + 수치. 분모가 0이면 막대 트랙까지 숨기고 "—" — 빈 트랙은 "0%" 로 오독된다.
 * 자리는 invisible 로 남겨 열 정렬을 지킨다. nowrap 이라 좁은 화면에서 막대와 수치가 두 줄로 갈리지 않는다.
 */
export function RateBar({ num, den, tone }: { num: number; den: number; tone: "success" | "primary" }) {
  const ratio = den > 0 ? Math.min(1, num / den) : null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-muted", ratio === null && "invisible")}>
        {ratio !== null && (
          <span className={cn("block h-full rounded-full", tone === "success" ? "bg-success" : "bg-primary")} style={{ width: `${ratio * 100}%` }} />
        )}
      </span>
      {/* 폭은 열 정렬을 위한 최소값이다 — 고정폭으로 두면 확대(200~400%)에서 수치가 잘린다 */}
      <span className="min-w-11 text-end tabular-nums">{ratio === null ? "—" : `${(ratio * 100).toFixed(ratio === 1 ? 0 : 1)}%`}</span>
    </span>
  );
}
