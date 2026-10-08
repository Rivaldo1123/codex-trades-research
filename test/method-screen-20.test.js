import assert from "node:assert/strict";
import test from "node:test";

import { buildTwentyMethodSignals, rankTwentyMethods } from "../src/method-screen-20.js";

test("twenty fixed methods emit only no-trade, Rise or Fall and reset after a gap", () => {
  const quotes = Float64Array.from({ length: 160 }, (_, index) => 100 + index * 0.1);
  const present = new Uint8Array(160).fill(1);
  present[80] = 0;
  const signals = buildTwentyMethodSignals(quotes, present, [120]);
  assert.equal(Object.keys(signals).length, 20);
  assert.equal(signals["sma10-20-trend"][60], 1);
  assert.equal(signals["sma10-20-contrarian"][60], 2);
  assert.equal(signals["sma10-20-trend"][80], 0);
  assert.equal(signals["sma10-20-trend"][81], 0);
  assert.equal(signals["sma10-20-trend"][99], 0);
  assert.equal(signals["sma10-20-trend"][100], 1);
  assert.equal(signals["sma10-20-trend"][120], 0);
  assert.equal(signals["sma10-20-trend"][139], 1);
  for (const vector of Object.values(signals)) {
    assert.equal(vector.length, 160);
    assert.ok([...vector].every((value) => value === 0 || value === 1 || value === 2));
  }
});

test("future quotes cannot change earlier method signals", () => {
  const first = Float64Array.from({ length: 100 }, (_, index) =>
    100 + Math.sin(index / 7) + index / 100);
  const changed = Float64Array.from(first);
  for (let index = 80; index < 100; index += 1) changed[index] += 20;
  const present = new Uint8Array(100).fill(1);
  const left = buildTwentyMethodSignals(first, present);
  const right = buildTwentyMethodSignals(changed, present);
  for (const id of Object.keys(left)) {
    assert.deepEqual([...left[id].subarray(0, 80)], [...right[id].subarray(0, 80)]);
  }
});

test("ranking uses middle-segment worst delay and keeps late results visible", () => {
  const ledger = [];
  for (const [id, middle, late] of [["alpha", 0.02, -0.1],
    ["beta", 0.01, 0.02], ["gamma", -0.01, 0.1]]) {
    for (const delayTicks of [1, 2, 3]) {
      for (const profitOnWin of [0.7, 0.8, 0.9]) {
        ledger.push({ methodId: id, delayTicks, profitOnWin,
          middle: { settledTrades: 300, averageProfitPerDollarStake: middle },
          late: { averageProfitPerDollarStake: late } });
      }
    }
  }
  const result = rankTwentyMethods(ledger, ["alpha", "beta", "gamma"]);
  assert.deepEqual(result.provisionalTopThree, ["alpha", "beta", "gamma"]);
  assert.equal(result.ranking[0].passesDevelopmentScreen, false);
  assert.equal(result.ranking[1].passesDevelopmentScreen, true);
});
