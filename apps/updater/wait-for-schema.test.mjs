// node --test apps/updater/wait-for-schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForTable } from "./wait-for-schema.mjs";

const noSleep = async () => {};

test("returns immediately when the table already exists", async () => {
  let calls = 0;
  const exists = async () => {
    calls++;
    return true;
  };
  await waitForTable(exists, { sleep: noSleep, onWait: () => assert.fail("should not wait") });
  assert.equal(calls, 1);
});

test("keeps polling until migrate has created the table", async () => {
  const answers = [false, false, true];
  const waits = [];
  await waitForTable(async () => answers.shift(), {
    sleep: noSleep,
    onWait: (attempt) => waits.push(attempt),
  });
  assert.deepEqual(waits, [1, 2]);
  assert.equal(answers.length, 0);
});

test("treats a transient query error as not ready yet instead of crashing", async () => {
  const answers = [new Error("connection refused"), true];
  const errors = [];
  await waitForTable(
    async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    { sleep: noSleep, onWait: (_attempt, err) => errors.push(err?.message ?? null) }
  );
  assert.deepEqual(errors, ["connection refused"]);
});
