"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 모달 다이얼로그 — 생성 폼의 공통 껍데기.
 *
 * 라이브러리를 쓰지 않는 이유: 필요한 동작이 포커스 트랩·Esc·스크롤 잠금 셋뿐이고,
 * 고객사 박스에 나가는 번들이라 의존성 하나가 그대로 용량과 취약점 감시 대상이 된다.
 *
 * body 로 portal 하는 이유: 조상에 transform/filter/overflow 가 있으면 fixed 가
 * 뷰포트가 아니라 그 조상 기준이 되어 모달이 화면 밖으로 밀린다. 콘솔 셸에는
 * backdrop-blur 헤더가 있어서 실제로 걸린다.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descId = React.useId();
  /** 닫은 뒤 포커스를 열기 전 위치로 돌려준다 — 키보드 사용자가 목록에서 길을 잃지 않게 */
  const restoreRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    // 배경 스크롤 잠금. 스크롤바가 사라지며 생기는 가로 흔들림은 padding 으로 상쇄한다.
    const { overflow, paddingRight } = document.body.style;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    /**
     * 본문의 첫 입력으로 포커스를 준다.
     *
     * 패널 전체에서 찾으면 헤더의 닫기(X) 버튼이 DOM 상 먼저라 거기에 포커스가 간다 —
     * 생성 폼을 열자마자 커서가 "닫기"에 있는 꼴이 된다. 그래서 본문으로 범위를 좁힌다.
     */
    const target =
      bodyRef.current?.querySelector<HTMLElement>(
        "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])"
      ) ??
      bodyRef.current?.querySelector<HTMLElement>("button:not([disabled])") ??
      panelRef.current;
    target?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      // 포커스 트랩 — 모달 밖으로 나가면 뒤 화면을 조작할 수 있게 되어 모달의 의미가 없다.
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes).filter((n) => n.offsetParent !== null);
      if (list.length === 0) return;

      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" }[size];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      {/* 배경 클릭으로 닫기. 폼 내용이 날아가므로 저장되지 않은 변경이 있으면 호출측이 막는다. */}
      <button
        type="button"
        aria-label="close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          // 모바일은 바텀시트, 데스크톱은 가운데. 긴 폼에서도 화면을 넘지 않게 스크롤은 본문에서만.
          "relative flex max-h-[90dvh] w-full flex-col rounded-t-card border border-border bg-surface shadow-lg outline-none sm:rounded-card",
          width
        )}
      >
        <div className="flex items-start justify-between gap-2.5 border-b border-border p-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-md font-bold tracking-tight text-foreground">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-3.5">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border p-3.5">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  );
}
