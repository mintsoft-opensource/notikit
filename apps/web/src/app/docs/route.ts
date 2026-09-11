/**
 * 고객이 읽는 API 문서 — Redoc (OpenAPI 렌더링).
 *
 * 콘솔과 같은 오리진이라 테마 선택(`localStorage.theme`)을 그대로 읽을 수 있다.
 * 별도 탭으로 열리지만 색이 어긋나지 않는다.
 *
 * Redoc 은 테마를 초기화 시점에만 받는다. 그래서 토글은 다시 init 한다 —
 * 스펙은 브라우저 캐시에서 오므로 다시 그리는 비용이 크지 않다.
 */
export const dynamic = "force-static";

/**
 * 버전을 고정한다. `latest` 를 쓰면 Redoc 이 새 버전을 낼 때 예고 없이 화면이 바뀌고,
 * 셀프호스팅한 쪽은 재현할 수 없는 차이를 떠안는다.
 */
const REDOC = "https://cdn.redoc.ly/redoc/v2.5.0/bundles/redoc.standalone.js";

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Notikit API 문서</title>
<style>
  /* globals.css 의 팔레트를 그대로 옮긴다 — 비슷한 색을 새로 고르면 콘솔과 어긋난다 */
  :root { --bg: #ffffff; --fg: #1c1f1c; --border: #e5e6e1; --muted: #6f746a; }
  html.dark { --bg: #292c26; --fg: #f3f4f0; --border: #52564d; --muted: #a2a69c; }
  body { margin: 0; background: var(--bg); color: var(--fg); }

  /* 토글 — 콘솔 헤더의 버튼과 같은 모양 */
  #theme {
    position: fixed; top: 12px; right: 16px; z-index: 100;
    display: flex; align-items: center; gap: 6px;
    height: 32px; padding: 0 10px;
    background: var(--bg); color: var(--muted);
    border: 1px solid var(--border); border-radius: 6px;
    font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
  }
  #theme:hover { color: var(--fg); }

  /* Redoc 이 그리지 못한 사이 배경이 흰색으로 번쩍이지 않게 */
  #redoc { background: var(--bg); min-height: 100vh; }
</style>
</head>
<body>
<button id="theme" type="button"></button>
<div id="redoc"></div>
<script src="${REDOC}"></script>
<script>
  // 콘솔과 같은 신호를 읽는다: 저장된 선택이 없으면 OS 설정을 따른다.
  function isDark() {
    try {
      var saved = localStorage.getItem("theme");
      if (saved) return saved === "dark";
    } catch (e) {}
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function themeFor(dark) {
    // mint500 / mint300 — 콘솔의 --primary 와 같은 값
    var accent = dark ? "#8fc3ae" : "#2e7d5b";
    // HTTP 메서드 색은 검증된 차트 팔레트(--chart-1..5)를 쓴다
    var method = dark
      ? { get: "#3f9ae0", post: accent, put: "#d0791d", delete: "#e04f7f", patch: "#8a6ff0" }
      : { get: "#1f7bbf", post: accent, put: "#d9730d", delete: "#c2255c", patch: "#7a5af0" };

    var common = {
      typography: {
        fontSize: "13px",
        lineHeight: "1.7",
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        headings: { fontFamily: "inherit", fontWeight: "700" },
        code: { fontSize: "12px", fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      },
      spacing: { unit: 4, sectionHorizontal: 24, sectionVertical: 16 },
      // 기본 둥근 모서리를 없애 콘솔의 각진 표와 맞춘다
      shape: { borderRadius: "0" },
    };

    return dark
      ? Object.assign({}, common, {
          colors: {
            primary: { main: accent },
            text: { primary: "#f3f4f0", secondary: "#a2a69c" },
            http: method,
            border: { dark: "#52564d", light: "#52564d" },
          },
          typography: Object.assign({}, common.typography, {
            code: Object.assign({}, common.typography.code, { color: "#f3f4f0", backgroundColor: "#141613" }),
          }),
          sidebar: { backgroundColor: "#292c26", textColor: "#f3f4f0", activeTextColor: accent },
          rightPanel: { backgroundColor: "#141613", textColor: "#f3f4f0" },
          schema: { nestedBackground: "#3c3f38", typeNameColor: "#a2a69c" },
        })
      : Object.assign({}, common, {
          colors: {
            primary: { main: accent },
            text: { primary: "#1c1f1c", secondary: "#6f746a" },
            http: method,
            border: { dark: "#e5e6e1", light: "#e5e6e1" },
          },
          typography: Object.assign({}, common.typography, {
            code: Object.assign({}, common.typography.code, { backgroundColor: "#f3f4f0" }),
          }),
          sidebar: { backgroundColor: "#fafaf8", textColor: "#1c1f1c", activeTextColor: accent },
          rightPanel: { backgroundColor: "#292c26", textColor: "#f3f4f0" },
          schema: { nestedBackground: "#f3f4f0", typeNameColor: "#6f746a" },
        });
  }

  function render() {
    var dark = isDark();
    document.documentElement.classList.toggle("dark", dark);
    document.getElementById("theme").textContent = dark ? "라이트 모드" : "다크 모드";
    Redoc.init("/api/openapi.json", { theme: themeFor(dark), hideDownloadButton: false, expandResponses: "200,201" },
               document.getElementById("redoc"));
  }

  document.getElementById("theme").addEventListener("click", function () {
    var next = !isDark();
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch (e) {}
    render();
  });

  // 저장된 선택이 없을 때만 OS 설정 변화를 따른다 — 콘솔과 같은 규칙
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    try { if (localStorage.getItem("theme")) return; } catch (e) {}
    render();
  });

  render();
</script>
</body>
</html>`;

export function GET() {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
