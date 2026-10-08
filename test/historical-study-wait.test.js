import assert from "node:assert/strict";
import test from "node:test";

import { classifyBackfillState } from "../src/historical-study-wait.js";

const options = { fromEpoch: 100, toEpoch: 200, symbol: "1HZ100V" };
const matching = { fromEpoch: 100, toEpochExclusive: 200, symbol: "1HZ100V" };

test("study waits for a matching completed backfill only", () => {
  assert.equal(classifyBackfillState({ ...matching, state: "RUNNING" }, options), "WAIT");
  assert.equal(classifyBackfillState({ ...matching, state: "BACKING_OFF" }, options), "WAIT");
  assert.equal(classifyBackfillState({ ...matching, state: "COMPLETED" }, options), "STUDY");
  assert.equal(classifyBackfillState({ ...matching, state: "INCOMPLETE" }, options), "BLOCKED");
  assert.equal(classifyBackfillState({ ...matching, state: "FAILED" }, options), "BLOCKED");
  assert.throws(
    () => classifyBackfillState({ ...matching, state: "COMPLETED", symbol: "OTHER" }, options),
    /does not match/,
  );
});
