import assert from "node:assert/strict";
import test from "node:test";

import { quoteSeriesFromPages,
  rankCrossVolatilitySymbol } from "../src/cross-volatility-screen.js";

test("cross-volatility quote loader requires every true tick at its native cadence", () => {
  const protocol = { fromEpoch: 100, toEpochExclusive: 108 };
  const symbol = { symbol: "R_10", secondsPerTick: 2, expectedTicks: 4 };
  const pages = [{ ticks: [[100, 1], [102, 2]] },
    { ticks: [[104, 3], [106, 4]] }];
  const series = quoteSeriesFromPages(pages, symbol, protocol);
  assert.deepEqual([...series.quotes], [1, 2, 3, 4]);
  assert.deepEqual([...series.present], [1, 1, 1, 1]);
  assert.equal(series.rowSha256.length, 64);
  assert.throws(() => quoteSeriesFromPages([{ ticks: [[100, 1], [104, 2]] }],
    symbol, protocol), /gap, overlap/);
  assert.throws(() => quoteSeriesFromPages([{ ticks: [[100, 1]] }],
    symbol, protocol), /Incomplete/);
  const withGap = quoteSeriesFromPages([{ ticks: [[100, 1], [104, 3]] }],
    symbol, protocol, { allowGaps: true });
  assert.deepEqual([...withGap.present], [1, 0, 1, 0]);
  assert.equal(withGap.observedTicks, 2);
});

test("cross-volatility screen ranks exhaustive scenarios but no-trade stays possible", () => {
  const ids = Array.from({ length: 550 }, (_, index) => `method-${index}`);
  const rows = [];
  for (const id of ids) {
    for (const delayTicks of [1, 2, 3]) {
      for (const profitOnWin of [0.7, 0.8, 0.9]) {
        const wins = id === "method-0" ? 80 : 50;
        const score = (wins * profitOnWin - (100 - wins)) / 100;
        rows.push({ methodId: id, delayTicks, profitOnWin,
          first: { settledTrades: 100, averageProfitPerDollarStake: score },
          second: { settledTrades: 100, averageProfitPerDollarStake: score } });
      }
    }
  }
  const ranked = rankCrossVolatilitySymbol(rows, ids);
  assert.equal(ranked.ranking.length, 550);
  assert.equal(ranked.bestObserved.methodId, "method-0");
  assert.equal(ranked.exploratoryPassCount, 1);
  const underpowered = rankCrossVolatilitySymbol(rows, ids, 101);
  assert.equal(underpowered.exploratoryPassCount, 0);
  assert.throws(() => rankCrossVolatilitySymbol(rows.slice(1), ids), /incomplete/);
});
