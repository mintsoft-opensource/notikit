"use client";

import * as React from "react";

/**
 * 현재 다크 모드 여부. 테마는 documentElement 의 `dark` 클래스로 관리되므로
 * 클래스 변화를 관찰한다 — 토글이 클래스를 바꾸는 순간 이 값을 쓰는 쪽도 같이 갱신된다.
 *
 * SSR 에서는 클래스를 알 수 없어 false 로 시작하고 마운트 직후 실제 값으로 맞춘다.
 */
export function useDarkMode(): boolean {
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    // 저장된 선택이 없으면 OS 설정을 따른다 — 그 설정이 바뀌면 즉시 반영
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem("theme")) return; // 사용자가 명시적으로 고른 값이 우선
      } catch {
        /* 저장소 접근 불가 — OS 설정을 따른다 */
      }
      root.classList.toggle("dark", e.matches);
    };
    mq.addEventListener("change", onScheme);

    return () => {
      observer.disconnect();
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  return dark;
}
