/**
 * 폐쇄망 번들 메타(bundle.json) 검증.
 *
 * `docker save repo@sha256:…` 로 저장한 이미지는 `docker load` 뒤에 **다이제스트로 찾을 수
 * 없다** — RepoDigests 는 레지스트리에서 받을 때만 붙고, save/load 를 거치면 사라진다.
 * 그래서 번들은 버전 태그로 저장하고, 그 이미지의 ID(설정 다이제스트)를 함께 적는다.
 * 업데이터는 로드 뒤 태그로 찾고 ID 가 같은지 본다 — 태그만 믿으면 같은 이름의 다른
 * 이미지가 이미 박스에 있어도 모른다. 레이어 목록(layers)은 선택이다 — 없으면 ID 로만 대조한다.
 *
 * 체크섬을 통과한 tar 안의 파일이지만 그래도 형식을 본다. 이 값이 그대로 docker 인자와
 * `.notikit-image.env` 한 줄이 된다.
 */

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const REF_CHARS = /^[a-z0-9.\-_/:]+$/i;

function isTagRef(ref) {
  if (typeof ref !== "string" || !REF_CHARS.test(ref) || ref.includes("@")) return false;
  // `host:5000/repo` 의 포트와 헷갈리지 않게 마지막 `/` 뒤에 `:태그` 가 있어야 한다
  const colon = ref.lastIndexOf(":");
  return colon > ref.lastIndexOf("/") && colon < ref.length - 1;
}

/** @returns {{ tag: string, imageId: string }} 로드 뒤 찾을 태그와 기대하는 이미지 ID */
export function parseBundleMeta(meta, expectedRef) {
  if (!meta || meta.kind !== "notikit-airgap-bundle") throw new Error("notikit 번들 메타가 아닙니다");

  // 번들이 가리키는 이미지와 콘솔에서 승인한 이미지가 달라선 안 된다
  if (meta.image !== expectedRef) {
    throw new Error(`번들의 이미지(${meta.image})가 승인된 이미지(${expectedRef})와 다릅니다`);
  }
  if (meta.imageTag === undefined && meta.imageId === undefined) {
    throw new Error("이 번들에는 이미지 태그가 없어 로드 뒤 이미지를 찾을 수 없습니다 — 다시 만든 번들을 반입하세요");
  }
  if (!isTagRef(meta.imageTag)) throw new Error(`번들의 이미지 태그가 올바르지 않습니다: ${String(meta.imageTag)}`);
  if (typeof meta.imageId !== "string" || !IMAGE_ID.test(meta.imageId)) {
    throw new Error(`번들의 이미지 ID 가 올바르지 않습니다: ${String(meta.imageId)}`);
  }
  const layers = meta.layers ?? null;
  if (layers !== null && !(Array.isArray(layers) && layers.length > 0 && layers.every((l) => IMAGE_ID.test(l)))) {
    throw new Error("번들의 레이어 목록이 올바르지 않습니다");
  }
  return { tag: meta.imageTag, imageId: meta.imageId, layers };
}

/**
 * 로드된 이미지가 번들에 적힌 그 이미지인가.
 *
 * classic 저장소는 이미지 ID 가 설정 다이제스트라 `imageId` 와 바로 맞는다. containerd 이미지
 * 저장소(Docker 29 신규 설치 기본값)는 ID 가 매니페스트 다이제스트라 어긋나므로, 그때는 저장소와
 * 무관한 레이어(diff_id) 목록으로 대조한다. 둘 다 아니면 다른 이미지다.
 */
export function matchesLoadedImage(target, loaded) {
  if (loaded.id === target.imageId) return "id";
  if (target.layers && JSON.stringify(loaded.layers) === JSON.stringify(target.layers)) return "layers";
  return null;
}
