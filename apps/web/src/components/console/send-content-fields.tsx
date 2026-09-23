"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ImageIcon } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { charLength, imageUrlState, IMAGE_URL_MAX } from "./send-rules";

/** 라벨 오른쪽의 글자 수 — 권장치를 넘으면 amber 로 바뀌고 잘림을 알린다 */
export function CharCounter({ id, value, max }: { id: string; value: string; max: number }) {
  const t = useTranslations("send");
  const count = charLength(value);
  const over = count > max;
  return (
    <span
      id={id}
      className={cn(
        "inline-flex items-center gap-1 text-2xs tabular-nums transition-colors",
        over ? "font-semibold text-warning" : "text-muted-foreground"
      )}
    >
      {over && <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />}
      <span className="sr-only">{t("charCountLabel", { count, max })}</span>
      <span aria-hidden="true">
        {count}/{max}
      </span>
      {over && <span>· {t("counterTruncate")}</span>}
    </span>
  );
}

/** 라벨과 글자 수를 한 줄에 — 입력칸 바로 위에서 한도를 보며 쓴다 */
export function CountedLabel({
  htmlFor,
  label,
  counterId,
  value,
  max,
}: {
  htmlFor: string;
  label: string;
  counterId: string;
  value: string;
  max: number;
}) {
  return (
    <div className="flex items-end justify-between gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      <CharCounter id={counterId} value={value} max={max} />
    </div>
  );
}

/** 이미지(리치 미디어) URL — https 만 받는다. 옆 썸네일로 주소가 맞는지 바로 확인한다 */
export function SendImageField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const id = React.useId();
  const hintId = `${id}-hint`;
  const state = imageUrlState(value);
  const [brokenSrc, setBrokenSrc] = React.useState<string | null>(null);
  const src = state === "valid" ? value.trim() : null;
  const showThumb = src !== null && brokenSrc !== src;
  const problem = state === "notHttps" || state === "invalid" || (src !== null && brokenSrc === src);

  const hint =
    state === "notHttps" ? t("imageNotHttps")
      : state === "invalid" ? t("imageInvalid")
      : src !== null && brokenSrc === src ? t("imageLoadFailed")
      : t("imageHint");

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("imageUrl")}</Label>
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <ImageIcon aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={id}
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            className={cn("ps-9 font-mono text-xs", problem && "border-warning/60 focus-visible:border-warning")}
            value={value}
            disabled={disabled}
            maxLength={IMAGE_URL_MAX}
            aria-invalid={state === "notHttps" || state === "invalid" || undefined}
            aria-describedby={hintId}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://cdn.example.com/banner.png"
          />
        </div>
        <div className="grid h-9 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-surface-muted">
          {showThumb ? (
            <img src={src} alt={t("imagePreviewAlt")} className="h-full w-full object-cover" onError={() => setBrokenSrc(src)} />
          ) : (
            <ImageIcon aria-hidden="true" className="h-4 w-4 text-muted-foreground/60" />
          )}
        </div>
      </div>
      <p id={hintId} className={cn("text-xs", problem ? "text-warning" : "text-muted-foreground")}>
        {hint}
      </p>
    </div>
  );
}
