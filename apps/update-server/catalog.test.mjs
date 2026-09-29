// node --test apps/update-server/catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmp, isPublishableVersion, resolve, hasMigrationsSince } from "./catalog.mjs";

const d = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const rel = (version, over = {}) => ({ version, channel: "stable", image: "r/notikit", digest: d(1), hasMigrations: false, ...over });

test("프리릴리스는 같은 버전의 정식보다 낮고, 프리릴리스끼리는 식별자 순이다", () => {
  assert.ok(cmp("1.3.0-beta.1", "1.3.0") < 0);
  assert.ok(cmp("1.3.0-beta.2", "1.3.0-beta.1") > 0);
  assert.ok(cmp("1.3.0-beta.10", "1.3.0-beta.2") > 0);
  assert.ok(cmp("1.3.0-alpha", "1.3.0-beta") < 0);
  assert.equal(cmp("v1.2.3", "1.2.3"), 0);
  assert.ok(cmp("1.10.0", "1.9.9") > 0);
});

test("등록 버전은 끝까지 semver 여야 한다 — 파일 경로로 쓰이므로 경로 조작을 막는다", () => {
  assert.equal(isPublishableVersion("1.2.0"), true);
  assert.equal(isPublishableVersion("1.3.0-beta.1"), true);
  assert.equal(isPublishableVersion("1.2.0/../../customers"), false);
  assert.equal(isPublishableVersion("1.2.0-x/../../etc"), false);
  assert.equal(isPublishableVersion("1.2.0 "), false);
  assert.equal(isPublishableVersion("v1.2.0"), false);
  assert.equal(isPublishableVersion(undefined), false);
});

const releases = [
  rel("1.0.0", { hasMigrations: true }),
  rel("1.1.0", { hasMigrations: true }),
  rel("1.2.0"),
  rel("1.3.0"),
  rel("1.3.0-beta.1", { channel: "beta", hasMigrations: true }),
  rel("1.3.0-beta.2", { channel: "beta" }),
];

test("건너뛴 버전 중 하나라도 마이그레이션이 있으면 true — 백업을 건너뛰지 않는다", () => {
  const target = releases.find((r) => r.version === "1.3.0");
  assert.equal(hasMigrationsSince(releases, target, "1.0.0"), true);
});

test("설치본 이후 구간에 마이그레이션이 없으면 false", () => {
  const target = releases.find((r) => r.version === "1.3.0");
  assert.equal(hasMigrationsSince(releases, target, "1.1.0"), false);
});

test("다른 채널의 릴리스는 구간에 넣지 않는다 — stable 매니페스트는 이전 stable 기준으로 판정된다", () => {
  const target = releases.find((r) => r.version === "1.3.0");
  assert.equal(hasMigrationsSince(releases, target, "1.2.0"), false);
});

test("프리릴리스 사이도 구간으로 센다", () => {
  const target = releases.find((r) => r.version === "1.3.0-beta.2");
  assert.equal(hasMigrationsSince(releases, target, "1.2.0"), true);
  assert.equal(hasMigrationsSince(releases, target, "1.3.0-beta.1"), false);
});

test("yanked 릴리스도 구간에 넣는다 — 그 스키마 변경은 다음 릴리스에 그대로 실려 있다", () => {
  const list = [rel("2.0.0"), rel("2.1.0", { yanked: true, hasMigrations: true }), rel("2.2.0")];
  assert.equal(hasMigrationsSince(list, list[2], "2.0.0"), true);
});

test("설치 버전을 모르면 true — 모르면 있다고 보고 백업을 뜬다", () => {
  const target = releases.find((r) => r.version === "1.2.0");
  assert.equal(hasMigrationsSince(releases, target, undefined), true);
  assert.equal(hasMigrationsSince(releases, target, "garbage"), true);
});

test("대상 자신의 플래그는 항상 반영된다", () => {
  const target = releases.find((r) => r.version === "1.1.0");
  assert.equal(hasMigrationsSince(releases, target, "1.1.0"), true);
});

test("resolve 는 채널의 최신을, 프리릴리스 순서까지 맞게 고른다", () => {
  const catalog = { releases: [...releases].sort((a, b) => cmp(a.version, b.version)), customers: {} };
  assert.equal(resolve(catalog, { customerId: "a", channel: "stable" }, null)?.version, "1.3.0");
  assert.equal(resolve(catalog, { customerId: "a", channel: "beta" }, null)?.version, "1.3.0-beta.2");
});

test("차단된 고객과 빈 채널은 null", () => {
  const catalog = { releases, customers: { gone: { blocked: true } } };
  assert.equal(resolve(catalog, { customerId: "gone", channel: "stable" }, null), null);
  assert.equal(resolve(catalog, { customerId: "a", channel: "nightly" }, null), null);
});
