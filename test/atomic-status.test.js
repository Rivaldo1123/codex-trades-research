import assert from "node:assert/strict";
import test from "node:test";

import { renameStatusFileWithRetry } from "../src/atomic-status.js";

function fileError(code) {
  return Object.assign(new Error(`rename failed: ${code}`), { code });
}

test("status rename retries transient Windows sharing errors", async () => {
  const codes = ["EPERM", "EACCES", "EBUSY"];
  const waits = [];
  let calls = 0;
  await renameStatusFileWithRetry("source", "destination", {
    renameFile: async (source, destination) => {
      assert.equal(source, "source");
      assert.equal(destination, "destination");
      const code = codes[calls];
      calls += 1;
      if (code) throw fileError(code);
    },
    wait: async (delay) => waits.push(delay),
  });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [25, 50, 100]);
});

test("status rename fails immediately on unrelated errors", async () => {
  const failure = fileError("ENOENT");
  let calls = 0;
  await assert.rejects(
    renameStatusFileWithRetry("source", "destination", {
      renameFile: async () => {
        calls += 1;
        throw failure;
      },
      wait: async () => assert.fail("unexpected retry"),
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("status rename fails closed after its finite retry budget", async () => {
  const failure = fileError("EPERM");
  let calls = 0;
  const waits = [];
  await assert.rejects(
    renameStatusFileWithRetry("source", "destination", {
      renameFile: async () => {
        calls += 1;
        throw failure;
      },
      wait: async (delay) => waits.push(delay),
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 8);
  assert.deepEqual(waits, [25, 50, 100, 200, 400, 800, 800]);
});
