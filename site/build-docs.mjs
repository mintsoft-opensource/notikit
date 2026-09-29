// 소개 사이트 빌드 — site/ 를 복사하고, 서버 가이드(apps/web/docs/*.md)를 /docs/*.html 로 만든다.
//
// 문서 원본은 콘솔 가이드와 같은 파일 하나다. 여기서 사본을 두면 둘이 어긋난다.
// 슬러그 규칙도 콘솔(apps/web/src/lib/docs.ts)과 같다: 파일명에서 순번과 확장자를 뺀 것.
//
//   node site/build-docs.mjs <marked 가 설치된 디렉터리> [출력 디렉터리=_site]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "apps/web/docs");
const SITE_DIR = path.join(ROOT, "site");
const [markedDir, outArg = "_site"] = process.argv.slice(2);
if (!markedDir) {
  console.error("usage: node site/build-docs.mjs <dir-with-marked> [out]");
  process.exit(1);
}
const markedEntry = createRequire(path.join(path.resolve(markedDir), "noop.js")).resolve("marked");
const { Marked } = await import(pathToFileURL(markedEntry).href);
const OUT = path.resolve(ROOT, outArg);
const EDIT_BASE = "https://github.com/mintsoft-opensource/notikit/edit/master/apps/web/docs/";
const ORDER_PREFIX = /^\d+[-_]/;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function splitFrontMatter(raw) {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const meta = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(end + 4) };
}

/** 한글을 살리는 제목 앵커. 같은 문서 안의 중복은 -2, -3 을 붙인다. */
function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

const docs = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((file) => {
    const { meta, body } = splitFrontMatter(readFileSync(path.join(DOCS_DIR, file), "utf8"));
    const slug = file.replace(/\.md$/, "").replace(ORDER_PREFIX, "");
    const title = meta.title || body.match(/^#\s+(.+)$/m)?.[1] || slug;
    return { file, slug, title, body };
  });
const known = new Set(docs.map((d) => d.slug));

/** 문서 사이 링크(`sending`, `04-sending`, `sending#앵커`)를 사이트 경로로 바꾼다. */
function rewriteHref(href) {
  const m = href.match(/^(?:\.\/)?([\w-]+?)(?:\.md)?(#.*)?$/);
  if (!m) return href;
  const slug = m[1].replace(ORDER_PREFIX, "");
  return known.has(slug) ? `${slug}.html${m[2] ?? ""}` : href;
}

function render(doc) {
  const slugger = makeSlugger();
  const toc = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const id = slugger(inner);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: inner.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(external ? href : rewriteHref(href))}"${t}${external ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
    },
  });
  // 본문 첫 h1 은 페이지 제목으로 따로 쓴다
  const body = doc.body.replace(/^\s*#\s+.+\n/, "");
  // 넓은 표는 본문 폭을 밀어내지 않고 표 안에서 가로로 스크롤된다
  const html = marked.parse(body).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return { html, toc };
}

function page({ doc, html, toc, prev, next }) {
  const nav = docs
    .map((d) => `<a href="${d.slug}.html"${d.slug === doc.slug ? ' aria-current="page"' : ""}>${escapeHtml(d.title)}</a>`)
    .join("\n          ");
  const tocHtml = toc.length > 1
    ? `<nav class="toc" aria-label="이 문서의 목차"><p>이 문서에서</p>${toc.map((t) => `<a class="d${t.depth}" href="#${t.id}">${escapeHtml(t.text)}</a>`).join("")}</nav>`
    : "";
  const pager = [
    prev ? `<a class="prev" href="${prev.slug}.html"><small>이전</small>${escapeHtml(prev.title)}</a>` : "<span></span>",
    next ? `<a class="next" href="${next.slug}.html"><small>다음</small>${escapeHtml(next.title)}</a>` : "<span></span>",
  ].join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(doc.title)} — Notikit 문서</title>
  <meta name="description" content="Notikit 가이드: ${escapeHtml(doc.title)}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M16 7a6 6 0 0 0-6 6v4l-2 3h16l-2-3v-4a6 6 0 0 0-6-6zm-2.5 15a2.5 2.5 0 0 0 5 0z' fill='white'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
  <link rel="stylesheet" href="../assets/base.css">
  <link rel="stylesheet" href="../assets/docs.css">
</head>
<body>
  <header class="top">
    <div class="wrap">
      <a class="brand" href="../" aria-label="Notikit 홈">
        <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" style="color: var(--accent)"/><path d="M16 7a6 6 0 0 0-6 6v4l-2 3h16l-2-3v-4a6 6 0 0 0-6-6zm-2.5 15a2.5 2.5 0 0 0 5 0z" fill="#fff"/></svg>
        Notikit <span class="brand-sub">문서</span>
      </a>
      <nav class="links" aria-label="주요 링크">
        <a class="hide-sm" href="../#sdk">SDK</a>
        <a href="./" aria-current="page">문서</a>
        <a href="https://github.com/mintsoft-opensource/notikit">GitHub</a>
      </nav>
    </div>
  </header>
  <div class="wrap docs">
    <aside class="side">
      <details class="side-menu" open>
        <summary>가이드</summary>
        <nav aria-label="문서 목록">
          ${nav}
        </nav>
      </details>
    </aside>
    <main class="doc">
      <p class="crumb"><a href="./">문서</a> / ${escapeHtml(doc.title)}</p>
      <h1>${escapeHtml(doc.title)}</h1>
      <article class="prose">
${html}
      </article>
      <p class="edit"><a href="${EDIT_BASE}${doc.file}">GitHub 에서 이 문서 고치기</a></p>
      <nav class="pager" aria-label="이전·다음 문서">${pager}</nav>
    </main>
    ${tocHtml}
  </div>
  <footer>
    <div class="wrap">
      <span>© MintSoft · Apache-2.0</span>
      <nav aria-label="바닥글 링크">
        <a href="https://github.com/mintsoft-opensource/notikit">서버</a>
        <a href="https://github.com/mintsoft-opensource/notikit-js">JS</a>
        <a href="https://github.com/mintsoft-opensource/notikit-ios">iOS</a>
        <a href="https://github.com/mintsoft-opensource/notikit-android">Android</a>
        <a href="https://github.com/mintsoft-opensource/notikit-flutter">Flutter</a>
      </nav>
    </div>
  </footer>
  <script>
    // 좁은 화면에서는 목록을 접어 두고 본문부터 보여 준다
    if (matchMedia("(max-width: 900px)").matches) document.querySelector(".side-menu").removeAttribute("open");
    // 읽고 있는 절을 목차에 표시한다
    (function () {
      var links = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
      if (!links.length || !("IntersectionObserver" in window)) return;
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          links.forEach(function (a) { a.classList.remove("on"); });
          var a = byId[e.target.id];
          if (a) a.classList.add("on");
        });
      }, { rootMargin: "0px 0px -70% 0px" });
      Object.keys(byId).forEach(function (id) { var h = document.getElementById(id); if (h) io.observe(h); });
    })();
  </script>
</body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
cpSync(SITE_DIR, OUT, { recursive: true, filter: (src) => !src.endsWith("build-docs.mjs") });
mkdirSync(path.join(OUT, "docs"), { recursive: true });

docs.forEach((doc, i) => {
  const { html, toc } = render(doc);
  writeFileSync(path.join(OUT, "docs", `${doc.slug}.html`), page({ doc, html, toc, prev: docs[i - 1], next: docs[i + 1] }));
});
// /docs/ 는 첫 문서로 보낸다(목차 페이지를 따로 두면 사이드바와 내용이 겹친다)
writeFileSync(
  path.join(OUT, "docs", "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Notikit 문서</title><meta http-equiv="refresh" content="0; url=${docs[0].slug}.html"><link rel="canonical" href="${docs[0].slug}.html"><a href="${docs[0].slug}.html">문서로 이동</a>\n`
);
console.log(`built ${docs.length} docs → ${path.relative(ROOT, OUT)}/docs`);
