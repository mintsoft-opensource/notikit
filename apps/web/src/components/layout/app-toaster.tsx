"use client";

import { Toaster } from "sonner";
import { useDarkMode } from "./use-dark-mode";

/**
 * sonner 는 theme 을 주지 않으면 light 로 고정된다 — 다크 모드에서 토스트만
 * 흰 배경으로 튀어나온다. 클래스 기반 테마를 따라가게 묶는다.
 */
export function AppToaster() {
  const dark = useDarkMode();
  return <Toaster position="top-center" richColors theme={dark ? "dark" : "light"} />;
}
