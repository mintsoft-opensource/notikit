import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 폐쇄망 반입 번들.
 *
 * 레지스트리에 닿을 수 없는 고객은 번들 파일을 박스에 반입하고, 콘솔에서 고른다.
 * **콘솔로 업로드받지 않는다** — 번들이 수 GB 라 HTTP 업로드는 실패할 지점이
 * 너무 많고, 어차피 파일은 이미 그 박스에 들어와 있다.
 */
const BUNDLE_DIR = process.env.BUNDLE_DIR ?? "/bundles";

export interface Bundle {
  /** 파일명만. 경로를 다루면 업데이터에게 임의 경로를 읽히게 된다 */
  file: string;
  version: string;
  image: string;
  digest: string;
  createdAt: string | null;
  sizeBytes: number;
  /** 체크섬 파일이 없으면 업데이터가 검증할 수 없어 설치를 거부한다 */
  verifiable: boolean;
}

function digestOf(image: string): string {
  const at = image.lastIndexOf("@");
  return at >= 0 ? image.slice(at + 1) : "";
}

/** 반입된 번들 목록. 디렉터리가 없거나 비어 있으면 빈 배열 — 폐쇄망이 아닌 설치다. */
export async function listBundles(): Promise<Bundle[]> {
  let files: string[];
  try {
    files = (await readdir(BUNDLE_DIR)).filter((f) => f.endsWith(".tar"));
  } catch {
    return [];
  }

  const bundles: Bundle[] = [];
  for (const file of files) {
    try {
      // 메타는 번들 옆의 .json 에서 읽는다. tar 를 열어 보려면 수 GB 를 훑어야 한다.
      const metaRaw = await readFile(path.join(BUNDLE_DIR, `${file}.json`), "utf8").catch(() => null);
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
      if (!meta || meta.kind !== "notikit-airgap-bundle") continue;

      const digest = digestOf(String(meta.image ?? ""));
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) continue;

      const [info, sum] = await Promise.all([
        stat(path.join(BUNDLE_DIR, file)),
        readFile(path.join(BUNDLE_DIR, `${file}.sha256`), "utf8").catch(() => null),
      ]);

      bundles.push({
        file,
        version: String(meta.version ?? "").replace(/^v/, ""),
        image: String(meta.image),
        digest,
        createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
        sizeBytes: info.size,
        verifiable: !!sum,
      });
    } catch {
      // 읽을 수 없는 번들 하나가 목록 전체를 막으면 안 된다
    }
  }
  return bundles.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export async function findBundle(file: string): Promise<Bundle | null> {
  // 목록과 대조해서만 고른다. 경로 조작으로 디렉터리 밖을 가리키지 못하게.
  return (await listBundles()).find((b) => b.file === path.basename(file)) ?? null;
}
