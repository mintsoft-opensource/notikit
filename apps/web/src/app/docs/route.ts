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
  /* [hidden] 의 UA display:none 보다 위 규칙(ID)이 세다 — 명시적으로 되돌린다 */
  #theme[hidden] { display: none; }

  /* Redoc 이 그리지 못한 사이 배경이 흰색으로 번쩍이지 않게 */
  #redoc { background: var(--bg); min-height: 100vh; }

  /*
   * "Authorizations:" / "Request Body schema:" 라벨은 Redoc 이 rgba(38,50,56,.5) 로
   * 하드코딩한다 — 테마 옵션이 닿지 않는다. 다크 배경에서는 글자가 배경에 묻혀
   * 완전히 사라지므로 여기서 덮는다.
   */
  #redoc h5 { color: var(--muted) !important; }

  /*
   * 우측 예제 패널의 선택된 탭("Payload" 등). Redoc 이 배경과 글자를 **같은 값**으로
   * 칠해서(둘 다 #f3f4f0) 다크에서 레이블이 통째로 사라진다 — 흰 박스만 남는다.
   * 배경은 그대로 두고 글자만 어둡게 되돌린다.
   */
  #redoc .react-tabs__tab--selected { color: #1c1f1c !important; }
  /* 선택 안 된 탭은 배경이 투명하므로 본문 색을 따라가야 읽힌다 */
  #redoc .react-tabs__tab:not(.react-tabs__tab--selected) { color: var(--fg) !important; }

  /* 임베드 시엔 콘솔 카드가 이미 여백을 주므로 Redoc 자체 여백을 줄인다 */
  html.embed #redoc [data-section-id], html.embed .api-content > div:first-child { padding-top: 0; }
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
      // 콘솔 사이드바만큼 폭이 줄어 기본 분기점(85rem)에서는 예제 패널이 접힌다.
      // 요청/응답 예제는 API 문서의 핵심이라 접히면 문서의 값이 절반으로 준다.
      breakpoints: { small: "38rem", medium: "64rem", large: "80rem" },
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

  // 콘솔 안(iframe)에 박힌 경우: 헤더에 이미 토글이 있으므로 자체 토글을 숨기고
  // 부모가 documentElement 의 class 를 직접 바꿔 준다.
  var params = new URLSearchParams(location.search);
  var embedded = params.has("embed");
  if (embedded) document.getElementById("theme").hidden = true;

  // 첫 그리기만 부모가 넘긴 쿼리를 쓴다. 그 시점엔 부모가 class 를 붙이기 전일 수 있고,
  // 그러면 Redoc 이 라이트로 init 되어 배경만 희고 글자는 다크용이 되어 읽을 수 없다.
  // 이후 토글은 부모가 바꾸는 class 가 정답이다.
  var first = embedded && params.has("theme");
  function wantsDark() {
    if (!embedded) return isDark();
    if (first) {
      first = false;
      return params.get("theme") === "dark";
    }
    return document.documentElement.classList.contains("dark");
  }

  // 마지막으로 그린 테마. 부모가 뒤늦게 붙이는 class 를 "변경" 으로 오인해
  // 다시 그리면 Redoc 이 같은 자리에 두 번 마운트되어 removeChild 로 죽는다.
  var painted = null;

  function render() {
    var dark = wantsDark();
    if (dark === painted) return;
    painted = dark;

    document.documentElement.classList.toggle("dark", dark);
    document.getElementById("theme").textContent = dark ? "라이트 모드" : "다크 모드";

    // 다시 그릴 땐 컨테이너를 통째로 갈아 끼운다. Redoc 이 이전 트리를 정리하지 않아
    // 같은 노드에 두 번 init 하면 서로의 DOM 을 지우려다 예외를 던진다.
    var old = document.getElementById("redoc");
    var fresh = document.createElement("div");
    fresh.id = "redoc";
    old.replaceWith(fresh);

    Redoc.init("/api/openapi.json", { theme: themeFor(dark), hideDownloadButton: false, expandResponses: "200,201" },
               fresh);
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

  // 임베드 상태에서 부모가 .dark 를 토글하면 Redoc 을 새 테마로 다시 그린다.
  // Redoc 은 init 시점에만 테마를 받으므로 다시 그리는 것 말고는 방법이 없다.
  // render() 보다 **먼저** 걸어야 그 사이에 들어온 변경을 놓치지 않는다.
  if (embedded) {
    new MutationObserver(function () {
      // painted 와 비교하므로 부모가 늦게 붙인 class 는 재렌더를 부르지 않는다
      render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }

  render();
</script>
</body>
</html>`;

export function GET() {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
