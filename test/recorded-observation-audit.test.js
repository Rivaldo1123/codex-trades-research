import assert from "node:assert/strict";
import test from "node:test";

import { reconstructRecordedTransaction } from "../src/recorded-observation-audit.js";

test("five-tick recorded contract enters next tick and exits five ticks later", () => {
  const purchaseEpoch = 1_700_000_000;
  const quotesByEpoch = new Map(Array.from({ length: 7 }, (_, index) => [
    purchaseEpoch + index,
    100 + index,
  ]));
  const result = reconstructRecordedTransaction({
    direction: "rise",
    durationTicks: 5,
    quotesByEpoch,
    transaction: {
      buyPrice: 1,
      entrySpot: 101,
      exitSpot: 106,
      profit: 0.9,
      timestamp: new Date(purchaseEpoch * 1_000).toISOString(),
    },
  });
  assert.equal(result.entryEpoch, purchaseEpoch + 1);
  assert.equal(result.exitEpoch, purchaseEpoch + 6);
  assert.equal(result.timingAndSpotsMatch, true);
  assert.equal(result.accountingMatches, true);
});

test("strict Rise/Fall records a tie as a full stake loss", () => {
  const purchaseEpoch = 1_700_000_000;
  const quotesByEpoch = new Map([
    [purchaseEpoch + 1, 100],
    [purchaseEpoch + 2, 100],
  ]);
  const result = reconstructRecordedTransaction({
    direction: "fall",
    durationTicks: 1,
    quotesByEpoch,
    transaction: {
      buyPrice: 1,
      entrySpot: 100,
      exitSpot: 100,
      profit: -1,
      timestamp: new Date(purchaseEpoch * 1_000).toISOString(),
    },
  });
  assert.equal(result.tie, true);
  assert.equal(result.won, false);
  assert.equal(result.expectedProfit, -1);
  assert.equal(result.accountingMatches, true);
});
