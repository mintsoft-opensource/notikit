// node --test apps/updater/bundle-meta.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBundleMeta, matchesLoadedImage } from "./bundle-meta.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const REF = `ghcr.io/acme/notikit@${DIGEST}`;
const LAYERS = [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`];

const meta = (over = {}) => ({
  kind: "notikit-airgap-bundle",
  v: 2,
  version: "1.2.0",
  image: REF,
  imageTag: "ghcr.io/acme/notikit:1.2.0",
  imageId: IMAGE_ID,
  layers: LAYERS,
  ...over,
});

test("승인된 이미지와 같은 번들은 로드 후 찾을 태그와 기대 이미지 ID 를 돌려준다", () => {
  assert.deepEqual(parseBundleMeta(meta(), REF), {
    tag: "ghcr.io/acme/notikit:1.2.0",
    imageId: IMAGE_ID,
    layers: LAYERS,
  });
});

test("번들의 이미지가 승인된 이미지와 다르면 거부한다", () => {
  assert.throws(() => parseBundleMeta(meta({ image: `ghcr.io/evil/notikit@${DIGEST}` }), REF), /승인된 이미지/);
});

test("태그가 없는 예전 번들은 거부한다 — docker load 뒤 다이제스트로는 이미지를 찾을 수 없다", () => {
  assert.throws(() => parseBundleMeta(meta({ imageTag: undefined, imageId: undefined }), REF), /다시 만든 번들/);
});

test("태그에 다이제스트가 섞이거나 형식이 어긋나면 거부한다", () => {
  assert.throws(() => parseBundleMeta(meta({ imageTag: REF }), REF), /태그/);
  assert.throws(() => parseBundleMeta(meta({ imageTag: "ghcr.io/acme/notikit:1.2.0 --rm" }), REF), /태그/);
  assert.throws(() => parseBundleMeta(meta({ imageTag: "ghcr.io/acme/notikit" }), REF), /태그/);
});

test("이미지 ID 가 sha256 형식이 아니면 거부한다", () => {
  assert.throws(() => parseBundleMeta(meta({ imageId: "latest" }), REF), /이미지 ID/);
});

test("번들 메타가 아니면 거부한다", () => {
  assert.throws(() => parseBundleMeta({ kind: "other" }, REF), /번들/);
  assert.throws(() => parseBundleMeta(null, REF), /번들/);
});

test("레이어 목록 형식이 어긋나면 거부한다", () => {
  assert.throws(() => parseBundleMeta(meta({ layers: ["nope"] }), REF), /레이어/);
});

test("로드된 이미지 ID 가 같으면 통과", () => {
  const target = parseBundleMeta(meta(), REF);
  assert.equal(matchesLoadedImage(target, { id: IMAGE_ID, layers: [] }), "id");
});

test("containerd 저장소처럼 ID 가 달라도 레이어가 같으면 통과", () => {
  const target = parseBundleMeta(meta(), REF);
  assert.equal(matchesLoadedImage(target, { id: `sha256:${"e".repeat(64)}`, layers: LAYERS }), "layers");
});

test("ID 도 레이어도 다르면 다른 이미지다 — 같은 태그의 다른 이미지가 박스에 있던 경우", () => {
  const target = parseBundleMeta(meta(), REF);
  assert.equal(matchesLoadedImage(target, { id: `sha256:${"e".repeat(64)}`, layers: [LAYERS[0]] }), null);
});
