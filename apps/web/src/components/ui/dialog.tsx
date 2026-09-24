"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 첫 포커스 위치.
 *
 * `firstField`(기본): 본문의 첫 입력 → 본문의 첫 버튼 → 패널 순. 헤더의 닫기(X)가 DOM 상
 *   먼저라 본문으로 범위를 좁힌다. 바로 타이핑을 시작하는 생성 폼에 맞다.
 * `dialog`: 패널 자체. 본문이 **읽을 내용 먼저**인 창(검토·확인)에서 쓴다 — 첫 입력이
 *   맨 아래 체크박스면 거기로 뛰어 버려서 스크린리더 사용자가 그 위의 대상·인원·경고를
 *   통째로 건너뛴다(WCAG 2.4.3). 패널은 aria-labelledby/describedby 를 달고 있으므로
 *   제목과 설명이 먼저 읽히고, 그다음 본문을 순서대로 훑게 된다.
 */
export type DialogInitialFocus = "firstField" | "dialog";

function initialFocusTarget(
  body: HTMLElement | null,
  panel: HTMLElement | null,
  mode: DialogInitialFocus
): HTMLElement | null {
  if (mode === "dialog") return panel;
  return (
    body?.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])"
    ) ??
    body?.querySelector<HTMLElement>("button:not([disabled])") ??
    panel
  );
}

/**
 * 모달 뒤 화면을 `inert` 로 만든다 — Tab 트랩만으로는 스크린리더 가상 커서·마우스 포커스가
 * 배경으로 샌다. 알림(aria-live) 영역인 형제는 건드리지 않는다: inert 안의 live region 은
 * 읽히지 않아 모달에서 저장해도 "저장됨" 토스트가 조용해진다.
 * 이미 inert 인 것(바깥 모달이 잠근 것)은 건드리지 않고, 내가 잠근 것만 되돌린다.
 */
export function lockBackground(container: HTMLElement): () => void {
  const locked: HTMLElement[] = [];
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement) || el === container || el.inert) continue;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NEXT-ROUTE-ANNOUNCER") continue;
    // 요소 **자체**가 알림 영역일 때만 건너뛴다(토스트 섹션). 후손까지 보면 앱 셸 전체가
    // body 의 한 자식이라, 셸 안 어딘가에 live region 이 있는 페이지는 배경이 통째로 안 잠긴다.
    if (el.matches("[aria-live]")) continue;
    el.inert = true;
    locked.push(el);
  }
  return () => locked.forEach((el) => (el.inert = false));
}

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
  initialFocus = "firstField",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** 읽을 내용이 먼저인 창은 `dialog` 로 — 자세한 이유는 DialogInitialFocus 주석 */
  initialFocus?: DialogInitialFocus;
}) {
  const tc = useTranslations("common");
  const containerRef = React.useRef<HTMLDivElement>(null);
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
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    initialFocusTarget(bodyRef.current, panelRef.current, initialFocus)?.focus();
  }, [open, initialFocus]);

  React.useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    const panel = panelRef.current;
    if (!container || !panel) return;
    const unlock = lockBackground(container);

    /** 위에 다른 모달이 떠 있으면(그 모달이 나를 inert 로 잠갔으면) 손대지 않는다 */
    const isTopmost = () => !container.inert;

    // 포커스가 잠근 배경으로 나가면 패널로 되돌린다(프로그램적 focus() 등 Tab 이 아닌 경로).
    function onFocusIn(e: FocusEvent) {
      if (!isTopmost()) return;
      const target = e.target as Node | null;
      if (!target || container!.contains(target)) return;
      if (target instanceof Element && target.closest("[inert]")) {
        initialFocusTarget(bodyRef.current, panel, initialFocus)?.focus();
      }
    }

    /**
     * 포커스된 요소가 DOM 에서 사라지면(예: 생성 폼 → 발급 키 화면) 포커스가 body 로 떨어져
     * 키보드 사용자는 모달 안에서 위치를 잃는다. 그 경우에만 첫 포커스 대상으로 옮긴다 —
     * 입력·검색 결과 갱신처럼 포커스가 살아 있는 변경에서는 움직이지 않는다.
     */
    const observer = new MutationObserver(() => {
      if (!isTopmost()) return;
      const active = document.activeElement;
      if (active && active !== document.body && document.contains(active)) return;
      initialFocusTarget(bodyRef.current, panel, initialFocus)?.focus();
    });
    observer.observe(panel, { childList: true, subtree: true });

    document.addEventListener("focusin", onFocusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      unlock();
      // 배경 inert 를 푼 **뒤에** 돌려준다 — inert 인 동안엔 focus() 가 무시된다
      restoreRef.current?.focus?.();
    };
  }, [open, initialFocus]);

  React.useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      // 겹친 모달이면 맨 위 것만 반응한다 — 아래 모달까지 Esc 로 함께 닫히지 않게
      if (containerRef.current?.inert) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      // 포커스 트랩 — 모달 밖으로 나가면 뒤 화면을 조작할 수 있게 되어 모달의 의미가 없다.
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes).filter((n) => n.offsetParent !== null);
      if (list.length === 0) return;

      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;

      const outside = !panelRef.current?.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
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
    <div ref={containerRef} className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      {/* 배경 클릭으로 닫기. 폼 내용이 날아가므로 저장되지 않은 변경이 있으면 호출측이 막는다. */}
      <button
        type="button"
        aria-label={tc("close")}
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
            aria-label={tc("close")}
            // 칸 밖에 따로 서 있는 버튼이므로 다른 단독 컨트롤과 같은 36px(D3)
            className="-my-1.5 -me-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
