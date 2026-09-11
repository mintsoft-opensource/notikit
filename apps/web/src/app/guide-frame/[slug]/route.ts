import { readDoc } from "@/lib/docs";

export const dynamic = "force-dynamic";

/**
 * iframe 안에 들어갈 문서 HTML.
 *
 * 문서를 앱과 같은 DOM 에 그리면 마크다운이 만든 요소(h1·table·pre …)가 콘솔의
 * 전역 스타일과 서로를 밀어낸다. iframe 으로 나누면 문서는 자기 스타일만 갖는다.
 *
 * 테마는 두 경로로 맞춘다.
 *  - 최초: `?theme=` 쿼리. 첫 페인트부터 올바른 색이라 깜빡임이 없다.
 *  - 이후: 부모가 보내는 postMessage. 토글을 눌러도 새로고침 없이 따라간다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const doc = await readDoc(slug);
  if (!doc) return new Response("Not found", { status: 404 });

  const dark = new URL(req.url).searchParams.get("theme") === "dark";

  const html = `<!doctype html>
<html lang="ko" class="${dark ? "dark" : ""}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.title)}</title>
<style>
  /* 콘솔의 토큰과 같은 값. iframe 은 부모 CSS 를 물려받지 않아 여기 다시 둔다. */
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
    --code-bg: #f6f7f9; --accent: #159570; --quote-bg: #f0f9f6;
  }
  html.dark {
    --bg: #17181a; --fg: #e8e9ea; --muted: #9aa0a6; --border: #2c2e31;
    --code-bg: #202225; --accent: #21a06f; --quote-bg: #182420;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 4px 48px;
    background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 13px; line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 { line-height: 1.3; font-weight: 700; letter-spacing: -0.01em; }
  h1 { font-size: 22px; margin: 4px 0 16px; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-top: 14px; border-top: 1px solid var(--border); }
  h3 { font-size: 14px; margin: 20px 0 8px; }
  p, li { color: var(--muted); }
  strong { color: var(--fg); font-weight: 600; }
  a { color: var(--accent); }
  ul, ol { padding-left: 20px; }
  li { margin: 4px 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px; background: var(--code-bg); color: var(--fg);
    padding: 1px 5px; border: 1px solid var(--border);
  }
  /* 넓은 코드가 문서를 가로로 밀지 않도록 자기 안에서 스크롤 */
  pre {
    background: var(--code-bg); border: 1px solid var(--border);
    padding: 12px; overflow-x: auto; margin: 12px 0;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 12px; line-height: 1.6; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: var(--code-bg); font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }
  td { color: var(--muted); }
  td strong, td code { color: var(--fg); }
  blockquote {
    margin: 14px 0; padding: 10px 14px;
    border: 0; border-left: 2px solid var(--accent); background: var(--quote-bg);
  }
  blockquote p { margin: 0; color: var(--fg); opacity: 0.85; }
</style>
</head>
<body>
${doc.html}
<script>
  // 부모가 테마를 바꾸면 따라간다. 같은 오리진만 받는다.
  addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === "notikit:theme") {
      document.documentElement.classList.toggle("dark", e.data.dark === true);
    }
  });
  // 문서 높이를 알려 부모가 iframe 을 늘리게 한다 — 안쪽 스크롤바가 두 겹으로 생기지 않게.
  function reportHeight() {
    parent.postMessage({ type: "notikit:height", height: document.body.scrollHeight }, location.origin);
  }
  addEventListener("load", reportHeight);
  new ResizeObserver(reportHeight).observe(document.body);
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 이 문서는 우리 콘솔 안에서만 열린다
      "content-security-policy": "frame-ancestors 'self'",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
