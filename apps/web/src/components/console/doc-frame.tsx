"use client";

import * as React from "react";
import { useDarkMode } from "@/components/layout/use-dark-mode";

/**
 * 문서 iframe.
 *
 * 높이를 콘텐츠에 맞춰 늘려, 문서 안에 별도 스크롤바가 생기지 않게 한다 — 페이지
 * 스크롤과 문서 스크롤이 겹치면 어느 쪽이 움직이는지 알 수 없다.
 */
export function DocFrame({ slug, title }: { slug: string; title: string }) {
  const dark = useDarkMode();
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(600);

  // 첫 로드는 쿼리로 테마를 넘겨 깜빡임을 없앤다. 이후 변경은 postMessage.
  const [src] = React.useState(() => `/guide-frame/${slug}`);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "notikit:height" && typeof e.data.height === "number") {
        setHeight(e.data.height);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  React.useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { type: "notikit:theme", dark },
      window.location.origin
    );
  }, [dark]);

  return (
    <iframe
      ref={ref}
      title={title}
      src={`${src}?theme=${dark ? "dark" : "light"}`}
      onLoad={() =>
        ref.current?.contentWindow?.postMessage(
          { type: "notikit:theme", dark },
          window.location.origin
        )
      }
      // 문서는 우리 서버가 만든 것이지만 실행 범위를 좁혀 둔다
      sandbox="allow-scripts allow-same-origin allow-popups"
      className="w-full border-0"
      style={{ height }}
    />
  );
}
