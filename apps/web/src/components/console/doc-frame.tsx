"use client";

import * as React from "react";
import { useDarkMode } from "@/components/layout/use-dark-mode";

/**
 * 문서 iframe.
 *
 * 높이를 콘텐츠에 맞춰 늘려, 문서 안에 별도 스크롤바가 생기지 않게 한다 — 페이지
 * 스크롤과 문서 스크롤이 겹치면 어느 쪽이 움직이는지 알 수 없다.
 *
 * 높이는 **부모가 직접 잰다**. 자식이 postMessage 로 알리게 두면, 서버가 그린
 * 마크업의 iframe 이 하이드레이션보다 먼저 로드를 끝내는 경우 알림이 리스너가
 * 붙기 전에 도착해 사라진다. 그러면 문서는 초기값에 멈춘 채 잘린다.
 * 같은 오리진이므로 부모가 재는 쪽이 타이밍에 좌우되지 않는다.
 */
export function DocFrame({ slug, title }: { slug: string; title: string }) {
  const dark = useDarkMode();
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState<number | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let observer: ResizeObserver | null = null;

    const measure = () => {
      const body = el.contentDocument?.body;
      if (!body) return;
      setHeight(body.scrollHeight);

      if (!observer) {
        observer = new ResizeObserver(() => setHeight(body.scrollHeight));
        observer.observe(body);
      }
    };

    // 이미 로드가 끝났을 수 있다(하이드레이션 이전 완료). load 만 기다리면 놓친다.
    measure();
    el.addEventListener("load", measure);
    return () => {
      el.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, [slug]);

  // 테마 전환은 새로고침 없이 따라가야 한다 — 문서를 다시 받으면 읽던 위치를 잃는다.
  React.useEffect(() => {
    const doc = ref.current?.contentDocument;
    doc?.documentElement.classList.toggle("dark", dark);
  }, [dark, height]);

  // src 는 마운트 시점의 테마로 **고정**한다. dark 를 넣으면 토글마다 문서를 다시 받는다.
  const [src] = React.useState(() => `/guide-frame/${slug}?theme=${dark ? "dark" : "light"}`);

  return (
    <iframe
      ref={ref}
      title={title}
      // 첫 페인트부터 올바른 색이도록 테마를 쿼리로 넘긴다
      src={src}
      className="w-full border-0"
      // 아직 못 쟀을 때 0 이면 레이아웃이 접혔다 펴진다. 한 화면 높이로 시작한다.
      style={{ height: height ?? 640 }}
    />
  );
}
