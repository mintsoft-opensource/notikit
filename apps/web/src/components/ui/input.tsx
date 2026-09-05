import * as React from "react";
import { cn } from "@/lib/utils";

/** 명시적 라벨(id/aria-label/aria-labelledby)이 없으면 placeholder 를 접근성 이름으로 폴백 */
function fallbackAriaLabel(props: { id?: string; placeholder?: string; "aria-label"?: string; "aria-labelledby"?: string }) {
  if (props["aria-label"] || props["aria-labelledby"] || props.id) return props["aria-label"];
  return props.placeholder;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      aria-label={fallbackAriaLabel(props)}
      className={cn(
        "flex h-10 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
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
        "flex min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
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

/** 라벨↔컨트롤을 htmlFor/id 로 연결 (useId). children 에 자동으로 id 주입. */
export function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactElement<{ id?: string }>;
}) {
  const generated = React.useId();
  const id = children.props.id ?? generated; // 라벨과 컨트롤이 동일 id 사용
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, { id })}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-sm transition-colors focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
