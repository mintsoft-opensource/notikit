/**
 * KPI 타일 격자 규칙 — 타일 컴포넌트(클라이언트)와 자리표시(서버)가 **같은** 배치를 그려야
 * 로딩이 끝날 때 화면이 튀지 않는다. 서버에서도 부를 수 있게 "use client" 밖에 둔다.
 */
const SPAN_DEFAULT = "col-span-1 md:col-span-2 xl:col-span-1";
const SPAN_MD_HALF = "col-span-1 md:col-span-3 xl:col-span-1";
const SPAN_WIDE_HALF = "col-span-2 md:col-span-3 xl:col-span-1";
const SPAN_WIDE = "col-span-2 md:col-span-2 xl:col-span-1";

export const STAT_TILE_GRID = "grid grid-cols-2 gap-4 md:grid-cols-6 xl:grid-cols-5";

export function statTileSpan(index: number, count: number): string {
  const mdTailPair = count % 3 === 2 && index >= count - 2; // 3열 마지막 줄에 둘만 남는다
  const oddTail = count % 2 === 1 && index === count - 1; // 2열 마지막 줄에 하나만 남는다
  if (oddTail) return mdTailPair ? SPAN_WIDE_HALF : SPAN_WIDE;
  return mdTailPair ? SPAN_MD_HALF : SPAN_DEFAULT;
}
