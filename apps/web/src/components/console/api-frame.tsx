"use client";

import * as React from "react";
import { useDarkMode } from "@/components/layout/use-dark-mode";

/**
 * API 문서(Redoc) iframe.
 *
 * 가이드 문서와 달리 높이를 콘텐츠에 맞추지 않는다. Redoc 은 좌측 목차와 우측 예제를
 * 화면 높이에 고정해 스스로 스크롤하도록 만들어졌다 — 높이를 늘리면 그 세 칸이 모두
 * 한 화면을 벗어나 목차가 따라오지 않는다. 뷰포트에 맞춰 두고 안에서 스크롤시킨다.
 */
export function ApiFrame({ title }: { title: string }) {
  const dark = useDarkMode();
  const ref = React.useRef<HTMLIFrameElement>(null);

  // 부모가 자식 문서의 class 를 직접 바꾼다. 자식은 이를 보고 Redoc 을 다시 그린다.
  React.useEffect(() => {
    const apply = () => ref.current?.contentDocument?.documentElement.classList.toggle("dark", dark);
    apply();
    const el = ref.current;
    el?.addEventListener("load", apply);
    return () => el?.removeEventListener("load", apply);
  }, [dark]);

  // src 는 마운트 시 테마로 고정한다 — 토글마다 바꾸면 문서를 통째로 다시 받는다.
  const [src] = React.useState(() => `/docs?embed=1&theme=${dark ? "dark" : "light"}`);

  return (
    <iframe
      ref={ref}
      title={title}
      src={src}
      className="h-[calc(100vh-11rem)] w-full border-0"
    />
  );
}
