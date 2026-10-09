/**
 * 문서 iframe 의 스타일.
 *
 * iframe 은 부모 CSS 를 물려받지 않으므로 토큰을 여기 다시 둔다. 값은 globals.css 의
 * 팔레트를 **그대로** 옮긴 것이다 — 비슷한 색을 새로 고르면 문서만 미묘하게 다른
 * 초록이 되어 콘솔 안에서 이물감이 생긴다.
 *
 * 본문만 13px(--text-md)로 올린다. 콘솔 본문은 11.5px 인데 그건 표를 훑는 크기다.
 * 문서는 이어서 읽는 글이라 같은 크기로 두면 피로하다.
 */
export const DOC_STYLE = `
:root {
  --gy50:#fafaf8; --gy100:#f3f4f0; --gy200:#e5e6e1; --gy300:#d2d4cc;
  --gy400:#a2a69c; --gy500:#6f746a; --gy600:#52564d; --gy700:#3c3f38;
  --gy800:#292c26; --gy900:#191b17;
  --mint50:#f0f7f4; --mint100:#dcede5; --mint300:#8fc3ae;
  --mint500:#2e7d5b; --mint700:#1f5540;

  --surface:#ffffff; --surface-muted:var(--gy100); --surface-sunken:var(--gy50);
  --fg:#1c1f1c; --muted:var(--gy500); --border:var(--gy200); --border-strong:var(--gy300);
  --accent:var(--mint500); --accent-soft:var(--mint50); --accent-line:var(--mint300);
}
html.dark {
  --surface:#18191c; --surface-muted:#25272c; --surface-sunken:#09090b;
  --fg:#ededef; --muted:#a4a8af; --border:#41444b; --border-strong:#5c606a;
  --accent:var(--mint300); --accent-soft:rgba(143,195,174,0.14); --accent-line:var(--mint300);
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 2px 4px;
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-sans, ui-sans-serif), system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.75;
  letter-spacing: -0.006em;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* ── 제목 ─────────────────────────────────────────────
   h2 위에만 구분선을 둔다. 문서 한 편이 여러 절로 나뉘는 단위가 h2 라, 여기에만
   선이 있어야 절 경계가 읽힌다. 모든 제목에 선을 그으면 경계가 사라진다. */
h1, h2, h3, h4 {
  color: var(--fg);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.35;
  scroll-margin-top: 12px;
}
h1 { font-size: 22px; margin: 0 0 6px; }
h1 + p { font-size: 14px; color: var(--muted); margin-top: 0; }
h2 { font-size: 17px; margin: 34px 0 12px; padding-top: 18px; border-top: 1px solid var(--border); }
h3 { font-size: 14px; margin: 24px 0 8px; }
h4 { font-size: 13px; margin: 18px 0 6px; color: var(--muted); }

/* 제목 옆 앵커 — 링크를 걸 수 있어야 문서를 가리켜 이야기할 수 있다 */
.anchor {
  margin-left: 6px; color: var(--border-strong); text-decoration: none;
  font-weight: 400; opacity: 0; transition: opacity .12s;
}
h2:hover .anchor, h3:hover .anchor, .anchor:focus-visible { opacity: 1; }
.anchor:hover { color: var(--accent); }

/* ── 본문 ───────────────────────────────────────────── */
p { margin: 10px 0; color: var(--muted); }
strong { color: var(--fg); font-weight: 650; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }

ul, ol { margin: 10px 0; padding-left: 18px; }
li { margin: 5px 0; color: var(--muted); }
li::marker { color: var(--border-strong); }
li > ul, li > ol { margin: 4px 0; }

/* ── 코드 ─────────────────────────────────────────────
   인라인 코드에 세로 패딩을 크게 주면 줄 간격이 들쭉날쭉해진다. 좌우만 띄운다. */
code {
  font-family: var(--font-mono, ui-monospace), SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.875em;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  color: var(--fg);
  word-break: break-word;
}
pre {
  margin: 12px 0;
  padding: 12px 14px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  /* 넓은 코드가 문서를 가로로 밀지 않도록 자기 안에서 스크롤 */
  overflow-x: auto;
  tab-size: 2;
}
pre code {
  background: none; border: 0; padding: 0; border-radius: 0;
  font-size: 12px; line-height: 1.7; color: var(--fg); word-break: normal;
}

/* ── 표 ───────────────────────────────────────────────
   display:block + overflow-x 로 표만 가로 스크롤시킨다. 페이지 전체가 밀리면
   본문 읽기가 망가진다. */
.table-wrap { margin: 14px 0; overflow-x: auto; border: 1px solid var(--border); }
table { border-collapse: collapse; width: 100%; min-width: 420px; font-size: 12.5px; }
thead th {
  position: sticky; top: 0;
  background: var(--surface-muted); color: var(--muted);
  font-size: 11px; font-weight: 700; text-align: left; white-space: nowrap;
  letter-spacing: 0.02em; text-transform: uppercase;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
tbody td { padding: 9px 12px; border-top: 1px solid var(--border); color: var(--muted); vertical-align: top; }
tbody tr:first-child td { border-top: 0; }
tbody td:first-child { color: var(--fg); font-weight: 600; white-space: nowrap; }
tbody td code { white-space: nowrap; }

/* ── 콜아웃 ───────────────────────────────────────────
   마크다운의 인용문을 콜아웃으로 쓴다. 배경까지 채워야 본문과 구분된다 —
   선만 그으면 긴 문서에서 눈에 들어오지 않는다. */
blockquote {
  margin: 16px 0; padding: 12px 14px;
  border: 1px solid var(--border); border-left: 3px solid var(--accent-line);
  background: var(--accent-soft);
}
blockquote p { margin: 0; color: var(--fg); }
blockquote p + p { margin-top: 8px; }
blockquote code { background: var(--surface); }

img { max-width: 100%; height: auto; }
`;
