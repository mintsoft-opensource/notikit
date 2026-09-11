#!/usr/bin/env node
/**
 * 폐쇄망 반입 번들.
 *
 * 레지스트리에 닿을 수 없는 고객(금융·공공·내부망)은 이 파일 하나를 반입한다.
 * 안에는 이미지와 매니페스트가 들어 있고, 업데이터가 `docker load` 로 푼다.
 *
 * 체크섬을 함께 낸다. 반입 과정에 사람의 손과 USB 가 끼기 때문에, 받은 것이
 * 보낸 것과 같은지 확인할 방법이 없으면 안 된다.
 *
 *   node tools/release/bundle.mjs --version 1.2.0 \
 *     --image reg/notikit@sha256:… --updater-image reg/notikit-updater:1.2.0 \
 *     --out notikit-1.2.0-airgap.tar
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const f = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i]?.startsWith("--")) f[argv[i].slice(2)] = argv[i + 1];
}
for (const r of ["version", "image", "out"]) {
  if (!f[r]) {
    console.error(`--${r} 가 필요합니다`);
    process.exit(1);
  }
}

const work = mkdtempSync(path.join(tmpdir(), "notikit-bundle-"));
try {
  const images = [f.image, f["updater-image"]].filter(Boolean);
  console.error(`[bundle] saving ${images.length} image(s)…`);
  execFileSync("docker", ["save", "-o", path.join(work, "images.tar"), ...images], { stdio: "inherit" });

  // 반입한 쪽이 무엇을 받았는지 알 수 있어야 한다 — 업데이터도 이걸 읽어 검증한다
  const meta = JSON.stringify(
    {
      kind: "notikit-airgap-bundle",
      v: 1,
      version: f.version.replace(/^v/, ""),
      image: f.image,
      updaterImage: f["updater-image"] ?? null,
      createdAt: f.createdAt ?? new Date().toISOString(),
    },
    null,
    2
  );
  writeFileSync(path.join(work, "bundle.json"), meta);
  execFileSync("tar", ["-cf", f.out, "-C", work, "images.tar", "bundle.json"], { stdio: "inherit" });

  // 같은 메타를 번들 **옆에도** 둔다. 콘솔이 목록을 그릴 때 수 GB tar 를 열지
  // 않아도 되게 — 목록 한 번에 번들마다 전체를 훑으면 화면이 뜨지 않는다.
  writeFileSync(`${f.out}.json`, meta);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 체크섬은 스트리밍으로 낸다 — 번들이 수 GB 라 통째로 메모리에 올리면 죽는다
const hash = createHash("sha256");
createReadStream(f.out)
  .on("data", (c) => hash.update(c))
  .on("end", () => {
    const sum = hash.digest("hex");
    writeFileSync(`${f.out}.sha256`, `${sum}  ${path.basename(f.out)}\n`);
    console.error(`[bundle] ${f.out}\n[bundle] sha256 ${sum}`);
  });
