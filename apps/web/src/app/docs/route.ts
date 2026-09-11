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

const REDOC = "https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js";

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Notikit API 문서</title>
<style>
  :root { --bg: #ffffff; --fg: #1a1a1a; --border: #e5e7eb; --muted: #6b7280; }
  html.dark { --bg: #17181a; --fg: #e8e9ea; --border: #2c2e31; --muted: #9aa0a6; }
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
    // 콘솔의 --chart-1 과 같은 초록 계열을 주색으로 쓴다
    var accent = dark ? "#21a06f" : "#159570";
    return dark
      ? {
          colors: { primary: { main: accent }, text: { primary: "#e8e9ea", secondary: "#9aa0a6" },
                    http: { get: "#3f9ae0", post: accent, put: "#d0791d", delete: "#e04f7f" },
                    border: { dark: "#2c2e31", light: "#2c2e31" } },
          typography: { fontSize: "13px", fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                        code: { fontSize: "12px", color: "#e8e9ea", backgroundColor: "#202225" },
                        headings: { fontWeight: "700" } },
          sidebar: { backgroundColor: "#17181a", textColor: "#e8e9ea", activeTextColor: accent },
          rightPanel: { backgroundColor: "#202225", textColor: "#e8e9ea" },
          schema: { nestedBackground: "#202225" },
        }
      : {
          colors: { primary: { main: accent },
                    http: { get: "#1f7bbf", post: accent, put: "#d9730d", delete: "#c2255c" } },
          typography: { fontSize: "13px", fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                        code: { fontSize: "12px", backgroundColor: "#f6f7f9" },
                        headings: { fontWeight: "700" } },
          sidebar: { backgroundColor: "#ffffff", activeTextColor: accent },
        };
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
