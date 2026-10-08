import assert from "node:assert/strict";
import test from "node:test";

import { overlayVerifiedHistory } from "../src/retrospective-pilot-replay.js";

test("retrospective rows fill only absent slots and leave original arrays intact", () => {
  const quotes = Float64Array.from([10, 0, 12]);
  const present = Uint8Array.from([1, 0, 1]);
  const result = overlayVerifiedHistory(quotes, present,
    [{ epoch: 101, quote: 11 }], 100);
  assert.deepEqual([...result.quotes], [10, 11, 12]);
  assert.deepEqual([...result.present], [1, 1, 1]);
  assert.deepEqual([...quotes], [10, 0, 12]);
  assert.deepEqual([...present], [1, 0, 1]);
  assert.throws(() => overlayVerifiedHistory(quotes, present,
    [{ epoch: 100, quote: 99 }], 100), /replace a live tick/);
  assert.throws(() => overlayVerifiedHistory(quotes, present,
    [{ epoch: 101, quote: 11 }, { epoch: 101, quote: 11 }], 100), /replace a live tick/);
});
