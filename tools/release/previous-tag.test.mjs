// node --test tools/release/previous-tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { previousTag } from "./previous-tag.mjs";

const tags = ["v1.1.0", "v1.2.0", "v1.3.0-beta.1", "v1.3.0-beta.2", "v1.3.0", "v1.4.0-beta.1", "vbogus"];

test("정식 릴리스는 이전 정식 태그와 비교한다 — v1.3.0-beta.1 이 v1.3.0 보다 위로 오지 않는다", () => {
  assert.equal(previousTag(tags, "1.3.0"), "v1.2.0");
});

test("프리릴리스는 이전 프리릴리스와 비교한다", () => {
  assert.equal(previousTag(tags, "1.3.0-beta.2"), "v1.3.0-beta.1");
  assert.equal(previousTag(tags, "1.4.0-beta.1"), "v1.3.0-beta.2");
});

test("현재보다 높은 태그는 고르지 않는다 — 옛 버전을 다시 태깅해도 미래와 비교하지 않는다", () => {
  assert.equal(previousTag(tags, "1.2.0"), "v1.1.0");
});

test("같은 채널에 이전 태그가 없으면 빈 문자열 — manifest 가 '마이그레이션 있음' 으로 본다", () => {
  assert.equal(previousTag(tags, "1.1.0"), "");
  assert.equal(previousTag(["v1.0.0"], "1.1.0-beta.1"), "");
});
