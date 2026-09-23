import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** 명시적 라벨(id/aria-label/aria-labelledby)이 없으면 placeholder 를 접근성 이름으로 폴백 */
function fallbackAriaLabel(props: { id?: string; placeholder?: string; "aria-label"?: string; "aria-labelledby"?: string }) {
  if (props["aria-label"] || props["aria-labelledby"] || props.id) return props["aria-label"];
  return props.placeholder;
}

/**
 * aria-invalid 일 때의 시각 상태. 메시지만 띄우면 **칸은 멀쩡해 보인다** —
 * 여러 칸이 한 줄에 있을 때 어디를 고쳐야 하는지 눈으로 알 수 없다.
 * 색만으로 알리지 않도록 메시지(Field error)와 항상 함께 쓴다.
 */
const invalidField =
  "aria-[invalid=true]:border-error aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-error/40";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      aria-label={fallbackAriaLabel(props)}
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground shadow-sm transition-colors file:me-3 file:h-7 file:rounded-md file:border-0 file:bg-surface-muted file:px-2.5 file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        invalidField,
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-label={fallbackAriaLabel(props)}
      className={cn(
        "flex min-h-16 w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        invalidField,
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-semibold text-foreground", className)} {...props} />;
}

/**
 * 라벨↔컨트롤을 htmlFor/id 로 연결 (useId). children 에 자동으로 id 주입.
 * hint 가 있으면 컨트롤의 `aria-describedby` 로 이어 준다 — 안 이으면 스크린리더는
 * 입력칸에서 "형식: …" 같은 안내를 듣지 못한다. 자식이 이미 가진 describedby 는 보존한다.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: string;
  /**
   * 오류 메시지. **이 칸 바로 아래**에 붙고 aria-invalid·aria-describedby 를 자동으로 이어 준다 —
   * 여러 칸이 한 줄에 있을 때 줄 전체에 걸친 메시지는 어느 칸 이야기인지 알려 주지 못한다.
   * 읽어 주는 일은 폼의 polite 영역이 맡는다(타이핑 도중 끼어들지 않게).
   */
  error?: string | null;
  children: React.ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  /** 남는 세로 공간을 컨트롤이 가져가야 할 때 사용 (예: 발송 본문) */
  className?: string;
}) {
  const generated = React.useId();
  const id = children.props.id ?? generated; // 라벨과 컨트롤이 동일 id 사용
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [children.props["aria-describedby"], error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })}
      {error && <p id={errorId} className="text-xs font-semibold text-error">{error}</p>}
      {hint && <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(
          "flex h-9 w-full appearance-none rounded-lg border border-border bg-surface px-2.5 pe-8 text-sm text-foreground shadow-sm transition-colors focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          invalidField,
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
    </div>
  );
}

