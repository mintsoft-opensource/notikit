import { readDoc } from "@/lib/docs";
import { DOC_STYLE } from "./doc-style";

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
<style>${DOC_STYLE}</style>
</head>
<body>
${enhance(doc.html)}
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

  // 앵커 클릭은 iframe 안에서 스크롤한다. 부모 URL 을 바꾸면 문서가 다시 로드된다.
  addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    var el = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // 문서 안 외부 링크는 새 탭으로 — iframe 안에서 열리면 콘솔이 사라진 것처럼 보인다.
  document.querySelectorAll('a[href^="http"]').forEach(function (a) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
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

/**
 * marked 가 낸 HTML 을 화면에 맞게 손본다.
 *  - h2/h3 에 id 와 앵커를 단다. 없으면 문서의 특정 절을 가리킬 방법이 없다.
 *  - 표를 스크롤 래퍼로 감싼다. 넓은 표가 문서를 통째로 가로로 밀지 않게.
 */
function enhance(html: string): string {
  const used = new Set<string>();

  return html
    .replace(/<h([23])>(.*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "");
      let id = slugify(text);
      // 같은 제목이 두 번 나오면 id 가 겹쳐 앵커가 첫 번째로만 간다
      let n = 2;
      while (used.has(id)) id = `${slugify(text)}-${n++}`;
      used.add(id);
      return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="이 절 링크">#</a></h${level}>`;
    })
    .replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
}

/** 한글 제목도 앵커로 쓸 수 있게 — 공백만 접고 URL 금지 문자를 턴다. */
function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-") || "section"
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
