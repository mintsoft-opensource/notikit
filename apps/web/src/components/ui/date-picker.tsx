"use client";

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type Labels, type Matcher } from "react-day-picker";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { RTL_LOCALES } from "@/i18n/locales";
import "react-day-picker/style.css";

/** `YYYY-MM-DD` ↔ Date. 타임존 때문에 `new Date("2026-01-01")` 은 UTC 자정으로 해석돼
 *  로컬이 UTC-면 하루 전으로 밀린다. 반드시 로컬 기준으로 만든다. */
function parse(v: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function format(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 날짜 선택기 — `YYYY-MM-DD` 문자열을 주고받는다(서버 쿼리에 그대로 쓰는 형식).
 *
 * 네이티브 `input[type=date]` 은 브라우저마다 생김새·동작이 달라 콘솔 톤과 어긋나고,
 * 사파리는 달력 없이 스피너만 준다. 요일·월 이름은 date-fns 로케일 25종을 번들에
 * 넣는 대신 앱이 이미 쓰는 `Intl` 로 만든다.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  clearLabel,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** `YYYY-MM-DD` — 이 날짜 이전은 선택 불가 */
  min?: string;
  /** `YYYY-MM-DD` — 이 날짜 이후는 선택 불가 */
  max?: string;
  placeholder: string;
  clearLabel: string;
  id?: string;
  className?: string;
}) {
  const locale = useLocale();
  const tc = useTranslations("common");
  const [open, setOpen] = React.useState(false);

  const selected = parse(value);
  const minDate = min ? parse(min) : undefined;
  const maxDate = max ? parse(max) : undefined;

  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const monthFmt = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }),
    [locale]
  );
  const weekdayFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);

  const fullDateFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "full" }), [locale]);
  const weekdayLongFmt = React.useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long" }), [locale]);

  /** DayPicker 기본 aria-label 은 영어 고정("Go to next month" 등)이라 스크린리더가 언어를 섞어 읽는다 */
  const labels = React.useMemo<Partial<Labels>>(
    () => ({
      labelNav: () => tc("calendarNav"),
      labelPrevious: () => tc("prevMonth"),
      labelNext: () => tc("nextMonth"),
      labelGrid: (d) => monthFmt.format(d),
      labelWeekday: (d) => weekdayLongFmt.format(d),
      labelDayButton: (d, modifiers) =>
        [fullDateFmt.format(d), modifiers.today && tc("today"), modifiers.selected && tc("selectedDate")]
          .filter(Boolean)
          .join(", "),
    }),
    [tc, monthFmt, weekdayLongFmt, fullDateFmt]
  );

  const disabled = React.useMemo(() => {
    const rules: Matcher[] = [];
    if (minDate) rules.push({ before: minDate });
    if (maxDate) rules.push({ after: maxDate });
    return rules;
  }, [minDate, maxDate]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* 폭은 래퍼가 정한다. 기본 w-40 이라 기존 사용처는 그대로고,
          className 으로 flex-1 등을 주면 버튼이 따라 늘어난다. */}
      <div className={cn("flex w-40 items-center gap-1", className)}>
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            className={cn(
              "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-sm shadow-sm transition-colors",
              "focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected ? df.format(selected) : placeholder}</span>
          </button>
        </Popover.Trigger>
        {selected && (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => onChange("")}
            // 날짜 칸에 붙은 보조 조작 — 칸 안 요소 규칙(D3) 28px·14px 아이콘
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 rounded-card border border-border bg-surface p-2 text-foreground shadow-lg"
        >
          <DayPicker
            mode="single"
            selected={selected}
            defaultMonth={selected ?? maxDate ?? undefined}
            disabled={disabled}
            onSelect={(d) => {
              // 같은 날짜를 다시 누르면 undefined 가 온다 — 해제로 취급한다
              onChange(d ? format(d) : "");
              setOpen(false);
            }}
            showOutsideDays
            labels={labels}
            // DayPicker 는 CSS 방향이 아니라 이 값으로 이전·다음 화살표와 방향키 이동을 뒤집는다
            dir={RTL_LOCALES.has(locale) ? "rtl" : "ltr"}
            formatters={{
              formatCaption: (m) => monthFmt.format(m),
              formatWeekdayName: (d) => weekdayFmt.format(d),
            }}
            // 라이브러리 기본 셀은 44px 이라 콘솔 밀도와 어긋난다. 변수명은 v10 style.css 기준.
            className={cn(
              "text-sm",
              "[--rdp-accent-color:var(--primary)] [--rdp-accent-background-color:var(--accent-soft)]",
              "[--rdp-today-color:var(--primary)] [--rdp-day-height:2rem] [--rdp-day-width:2rem]",
              "[--rdp-weekday-opacity:1] [--rdp-outside-opacity:0.4]"
            )}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
