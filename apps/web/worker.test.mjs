// node --test apps/web/worker.test.mjs
// worker.mjs 는 빌드 없는 단독 스크립트라 vitest(src/**) 밖에 있다. 그래서 node 내장 러너로 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSweepDue, sweepTimeFor, utcDay, listProjects, nightlyDone } from "./worker.mjs";

const PID = "00000000-0000-0000-0000-000000000001";

test("스윕 시각 전에는 돌지 않는다", () => {
  const at = new Date(sweepTimeFor(PID, new Date("2026-09-29T12:00:00Z"), 3));
  const before = new Date(at.getTime() - 1000);
  assert.equal(isSweepDue(PID, before, undefined, 3), false);
});

test("스윕 시각이 지난 뒤 첫 tick 이면 분(minute)이 지나 있어도 돈다 — tick 이 늦어져도 하루를 놓치지 않는다", () => {
  const at = new Date(sweepTimeFor(PID, new Date("2026-09-29T12:00:00Z"), 3));
  const late = new Date(at.getTime() + 3 * 60 * 60_000);
  assert.equal(isSweepDue(PID, late, undefined, 3), true);
});

test("오늘 끝낸 스윕은 다시 돌지 않고, 다음 날 스윕 시각 뒤에 다시 돈다", () => {
  const at = new Date(sweepTimeFor(PID, new Date("2026-09-29T12:00:00Z"), 3));
  const later = new Date(at.getTime() + 60_000);
  assert.equal(isSweepDue(PID, later, utcDay(later), 3), false);

  const tomorrow = new Date(at.getTime() + 24 * 60 * 60_000);
  assert.equal(isSweepDue(PID, tomorrow, utcDay(later), 3), true);
});

test("스윕 시각은 프로젝트마다 분 단위로 흩어지고 지정한 UTC 시에 있다", () => {
  const t = new Date(sweepTimeFor(PID, new Date("2026-09-29T00:00:00Z"), 5));
  assert.equal(t.getUTCHours(), 5);
  assert.equal(utcDay(t), "2026-09-29");
});

test("purge 가 done:false 면 오늘 끝난 것으로 치지 않는다 — 다음 tick 이 이어서 지운다", () => {
  assert.equal(nightlyDone.purge({ data: { purged: 5000, done: false } }), false);
  assert.equal(nightlyDone.purge({ data: { purged: 10, done: true } }), true);
  // 응답이 없거나 오류 본문이면 다음 tick 에 다시 시도한다
  assert.equal(nightlyDone.purge(null), false);
  assert.equal(nightlyDone.purge({ error: "Forbidden" }), false);
});

test("토큰 점검은 partial 이 남으면 끝나지 않았고, 이미 검사됐거나 다른 워커가 가져갔으면 끝났다", () => {
  assert.equal(nightlyDone.tokens({ data: { partial: true } }), false);
  assert.equal(nightlyDone.tokens({ data: { partial: false } }), true);
  assert.equal(nightlyDone.tokens({ data: { alreadyChecked: true } }), true);
  assert.equal(nightlyDone.tokens({ data: { leaseLost: true, partial: false } }), true);
  assert.equal(nightlyDone.tokens(null), false);
  assert.equal(nightlyDone.tokens({ error: "Rate limit exceeded" }), false);
});

test("프로젝트 목록이 !ok 면 null — 틀린 ADMIN_TOKEN 이 '프로젝트 0개'로 조용히 넘어가지 않는다", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  assert.equal(await listProjects(fetchImpl), null);
});

test("프로젝트 목록은 커서를 끝까지 따라간다", async () => {
  const pages = [
    { data: { projects: [{ id: "a" }], next: { ts: "2026-01-01T00:00:00Z", id: "a" } } },
    { data: { projects: [{ id: "b" }], next: null } },
  ];
  let i = 0;
  const fetchImpl = async () => new Response(JSON.stringify(pages[i++]), { status: 200 });
  assert.deepEqual(await listProjects(fetchImpl), [{ id: "a" }, { id: "b" }]);
});

test("네트워크 오류도 null", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await listProjects(fetchImpl), null);
});
