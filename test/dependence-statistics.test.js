import assert from "node:assert/strict";
import test from "node:test";

import {
  clusteredRatioTTest,
  movingDayBlockBootstrapLowerBound,
} from "../src/dependence-statistics.js";

test("clustered ratio inference targets profit per stake, not an equal-day mean", () => {
  const blocks = [
    { wins: 1, losses: 0, trades: 1 },
    { wins: 0, losses: 100, trades: 100 },
  ];
  const result = clusteredRatioTTest(blocks, {
    comparisons: 1,
    netProfitOnWin: 0.9,
  });
  assert.equal(result.totalTrades, 101);
  assert.ok(Math.abs(result.averageNetProfitPerUnitStaked - (-99.1 / 101)) < 1e-12);
  assert.ok(result.rawOneSidedPValue > 0.5);
});

test("moving UTC-day block bootstrap is deterministic and preserves ratio accounting", () => {
  const blocks = Array.from({ length: 10 }, (_, day) => day < 5
    ? { wins: 4, losses: 6, trades: 10 }
    : { wins: 3, losses: 7, trades: 10 });
  const settings = {
    blockLengthDays: 3,
    confidence: 0.95,
    netProfitOnWin: 0.9,
    repetitions: 500,
    seed: 20261008,
  };
  const first = movingDayBlockBootstrapLowerBound(blocks, settings);
  const second = movingDayBlockBootstrapLowerBound(blocks, settings);
  assert.deepEqual(first, second);
  assert.ok(first.lowerBound < 0);
});

test("day-block statistics reject malformed trade identities", () => {
  assert.throws(() => clusteredRatioTTest([
    { wins: 2, losses: 1, trades: 2 },
    { wins: 1, losses: 1, trades: 2 },
  ], { comparisons: 1, netProfitOnWin: 0.9 }), /invalid counts/);
});
