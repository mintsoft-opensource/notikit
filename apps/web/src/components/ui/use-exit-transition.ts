"use client";

import * as React from "react";

/** 모달·드로어 전환 길이. globals.css 의 animate-* 규칙과 **같은 값**이어야 한다. */
export const EXIT_MS = 150;

/**
 * 닫힌 뒤에도 나가는 동작이 끝날 때까지만 더 그려 둔다.
 *
 * React 는 `open` 이 false 가 되는 순간 트리를 지우므로, 나가는 애니메이션은
 * 언마운트를 잠시 미뤄야 보인다. 들어오는 쪽은 마운트가 곧 시작이라 따로 없다.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useExitTransition(open: boolean, ms: number = EXIT_MS) {
  const [rendered, setRendered] = React.useState(open);

  React.useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    // 모션을 줄이기로 한 사용자에게는 나가는 동작이 없다 — 지연도 없어야 한다.
    // (globals.css 가 애니메이션을 없애므로, 지연만 남으면 닫기가 괜히 150ms 늦는다)
    if (prefersReducedMotion()) {
      setRendered(false);
      return;
    }
    const id = window.setTimeout(() => setRendered(false), ms);
    return () => window.clearTimeout(id);
  }, [open, ms]);

  return { rendered, leaving: rendered && !open };
}
