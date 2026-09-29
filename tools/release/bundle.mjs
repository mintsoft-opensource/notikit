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
 *
 * **이 머신의 아키텍처용 이미지만 담긴다.** `docker save` 는 로컬 이미지 하나를 저장하고,
 * 멀티 아키텍처 인덱스를 통째로 담지 않는다. CI 러너(amd64)에서 만들면 amd64 전용이다.
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

const version = f.version.replace(/^v/, "");
const at = f.image.lastIndexOf("@");
if (at < 0 || !/^sha256:[a-f0-9]{64}$/.test(f.image.slice(at + 1))) {
  console.error("--image 는 repo@sha256:… 형식이어야 합니다 — 콘솔이 다이제스트로 승인한다");
  process.exit(1);
}
/**
 * 다이제스트 참조로 save 하면 태그 없는 이미지가 담긴다. `docker load` 는 RepoDigests 를
 * 복원하지 않으므로 반입한 쪽에서 그 이미지를 **찾을 방법이 없다.** 버전 태그를 붙여
 * 저장하고, 이미지 ID 를 메타에 적어 업데이터가 로드 뒤 같은 이미지인지 확인하게 한다.
 */
const imageTag = `${f.image.slice(0, at)}:${version}`;

/**
 * 저장된 tar 의 manifest.json 에서 이 태그의 설정 다이제스트(= classic 저장소의 이미지 ID)를
 * 읽는다. 러너의 `docker image inspect .Id` 를 쓰지 않는 이유: containerd 이미지 저장소에서는
 * 그 값이 매니페스트(인덱스) 다이제스트라, 반입한 쪽에서 로드한 이미지의 ID 와 어긋난다.
 */
function configDigestOf(imagesTar, tag) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", imagesTar, "manifest.json"], { encoding: "utf8" }));
  const entry = manifest.find((m) => (m.RepoTags ?? []).includes(tag));
  // "blobs/sha256/<hex>" (OCI 레이아웃) 또는 "<hex>.json" (예전 형식)
  const hex = /([a-f0-9]{64})(\.json)?$/.exec(entry?.Config ?? "")?.[1];
  if (!hex) throw new Error(`images.tar 에서 ${tag} 의 설정 다이제스트를 찾지 못했습니다`);
  return `sha256:${hex}`;
}

const work = mkdtempSync(path.join(tmpdir(), "notikit-bundle-"));
try {
  execFileSync("docker", ["tag", f.image, imageTag], { stdio: "inherit" });
  // 레이어(diff_id) 목록은 이미지 저장소 방식(classic/containerd)과 무관하게 같다 — 업데이터의 보조 대조용
  const layers = JSON.parse(
    execFileSync("docker", ["image", "inspect", imageTag, "--format", "{{json .RootFS.Layers}}"], { encoding: "utf8" })
  );

  const images = [imageTag, f["updater-image"]].filter(Boolean);
  console.error(`[bundle] saving ${images.length} image(s)…`);
  execFileSync("docker", ["save", "-o", path.join(work, "images.tar"), ...images], { stdio: "inherit" });
  const imageId = configDigestOf(path.join(work, "images.tar"), imageTag);

  // 반입한 쪽이 무엇을 받았는지 알 수 있어야 한다 — 업데이터도 이걸 읽어 검증한다.
  // `image` 는 콘솔이 승인하는 다이제스트 참조, `imageTag`·`imageId` 는 로드 뒤 찾고 대조할 값이다.
  const meta = JSON.stringify(
    {
      kind: "notikit-airgap-bundle",
      v: 2,
      version,
      image: f.image,
      imageTag,
      imageId,
      layers,
      updaterImage: f["updater-image"] ?? null,
      // 러너 아키텍처분만 담긴다(docker save 는 로컬 이미지 하나를 저장한다)
      platform: execFileSync("docker", ["image", "inspect", f.image, "--format", "{{.Os}}/{{.Architecture}}"], {
        encoding: "utf8",
      }).trim(),
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
