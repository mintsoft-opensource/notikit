import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  // ReactNode 인 이유: 제목 옆에 상태 배지를 붙이는 화면이 있다(토픽 상세).
  // h1 안에 span 이 들어가는 건 유효하고, 배지가 제목의 일부로 읽히는 게 맞다.
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 md:flex-row md:items-center md:justify-between", className)}>
      <div>
        <h1 className="text-xl font-extrabold tracking-tight text-foreground md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-xs text-muted-foreground md:text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
