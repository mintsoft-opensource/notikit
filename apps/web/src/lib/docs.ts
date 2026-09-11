import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";

/**
 * 파일시스템 기반 문서.
 *
 * `apps/web/docs/*.md` 에 파일을 넣으면 **코드를 고치지 않아도** 사이드바에 나타난다.
 * 정렬은 파일명 앞의 숫자로 한다(`01-`, `02-` …) — 별도 목차 파일을 두면 파일과
 * 목차가 어긋나는 순간 문서가 사라지거나 404 가 된다.
 *
 * 목록은 짧게 캐시한다. 매 요청 디스크를 치는 것은 낭비지만, 영구 캐시하면 문서를
 * 넣어도 재시작 전까지 보이지 않아 "파일만 넣으면 된다"는 약속이 깨진다.
 */
const DOCS_DIR = path.join(process.cwd(), "docs");
const ORDER_PREFIX = /^\d+[-_]/;

export interface DocMeta {
  /** URL 에 쓰는 값. 파일명에서 순번과 확장자를 뺀 것 */
  slug: string;
  title: string;
}

export interface Doc extends DocMeta {
  html: string;
}

/** `---\ntitle: …\n---` 앞머리를 떼어 낸다. 없으면 본문 그대로. */
function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(end + 4) };
}

function slugOf(file: string): string {
  return file.replace(/\.md$/, "").replace(ORDER_PREFIX, "");
}

/** 캐시 수명. 문서를 넣고 이 시간 안에 목록에 나타난다. */
const CACHE_MS = 10_000;
let cache: { at: number; docs: DocMeta[] } | null = null;

/** 사이드바용 목록. 파일명 순서 그대로. */
export async function listDocs(): Promise<DocMeta[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.docs;

  let files: string[];
  try {
    files = (await readdir(DOCS_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return []; // 문서 디렉터리가 없어도 화면이 죽지 않는다
  }

  const docs = await Promise.all(
    files.map(async (file) => {
      const { meta, body } = splitFrontMatter(await readFile(path.join(DOCS_DIR, file), "utf8"));
      // title 이 없으면 첫 h1 을, 그것도 없으면 파일명을 쓴다
      const h1 = body.match(/^#\s+(.+)$/m)?.[1];
      return { slug: slugOf(file), title: meta.title || h1 || slugOf(file) };
    })
  );

  cache = { at: Date.now(), docs };
  return docs;
}

/** 한 편을 HTML 로. 없으면 null — 호출부가 404 를 낸다. */
export async function readDoc(slug: string): Promise<Doc | null> {
  // slug 는 URL 에서 온다. 경로 조작으로 저장소 밖 파일을 읽지 못하게 목록과 대조한다.
  const known = (await listDocs()).find((d) => d.slug === slug);
  if (!known) return null;

  let files: string[];
  try {
    files = await readdir(DOCS_DIR);
  } catch {
    return null;
  }
  const file = files.find((f) => f.endsWith(".md") && slugOf(f) === slug);
  if (!file) return null;

  const { body } = splitFrontMatter(await readFile(path.join(DOCS_DIR, file), "utf8"));
  return { ...known, html: await marked.parse(body) };
}
