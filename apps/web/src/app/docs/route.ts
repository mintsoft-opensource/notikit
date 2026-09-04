/** 고객이 읽는 API 문서 — Scalar API Reference (OpenAPI 렌더링) */
export const dynamic = "force-static";

const html = `<!doctype html>
<html>
  <head>
    <title>Notikit API 문서</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/openapi.json"></script>
    <script>
      var cfg = { theme: "purple" };
      document.getElementById("api-reference").dataset.configuration = JSON.stringify(cfg);
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export function GET() {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
