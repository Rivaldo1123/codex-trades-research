import assert from "node:assert/strict";
import test from "node:test";

import { buildThirtyNewMethodSignals, newMethodIds,
  rankFiftyMethods } from "../src/method-screen-50.js";

test("thirty new fixed variants are distinct and only emit no-trade, Rise or Fall", () => {
  const ids = newMethodIds();
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  const quotes = Float64Array.from(Array.from({ length: 65 }, (_, index) => index + 100));
  const present = Uint8Array.from(quotes, () => 1);
  const signals = buildThirtyNewMethodSignals(quotes, present);
  assert.deepEqual(Object.keys(signals), ids);
  assert.equal(signals["tick-momentum-2-trend"][2], 1);
  assert.equal(signals["tick-momentum-2-reverse"][2], 2);
  assert.equal(signals["tick-streak-2-trend"][2], 1);
  assert.equal(signals["price-sma-50-trend"][49], 1);
  assert.equal(signals["tick-impulse-20-1.5-trend"][20], 0);
  for (const row of Object.values(signals)) {
    assert.equal(row.length, quotes.length);
    assert.ok(row.every((value) => value === 0 || value === 1 || value === 2));
  }
});

test("new variants use no future quote and reset warmup at gaps and split boundaries", () => {
  const quotes = Float64Array.from(Array.from({ length: 120 }, (_, index) => 100 + index));
  const present = Uint8Array.from(quotes, () => 1);
  const first = buildThirtyNewMethodSignals(quotes, present, [80]);
  quotes[119] = -1000;
  const changedFuture = buildThirtyNewMethodSignals(quotes, present, [80]);
  for (const id of newMethodIds()) {
    assert.deepEqual(first[id].slice(0, 119), changedFuture[id].slice(0, 119));
  }
  assert.equal(first["tick-momentum-30-trend"][80], 0);
  assert.equal(first["price-sma-50-trend"][80], 0);
  assert.equal(first["tick-streak-2-trend"][80], 0);
  present[60] = 0;
  const withGap = buildThirtyNewMethodSignals(quotes, present, [80]);
  assert.equal(withGap["tick-momentum-30-trend"][60], 0);
  assert.equal(withGap["tick-momentum-30-trend"][61], 0);
  assert.equal(withGap["price-sma-50-trend"][61], 0);
  assert.equal(withGap["tick-impulse-20-1.5-trend"][61], 0);
});

test("fifty-method ranking cannot turn a development result into trading permission", () => {
  const ids = Array.from({ length: 50 }, (_, index) => `method-${index}`);
  const ledger = [];
  for (const id of ids) {
    for (const delayTicks of [1, 2, 3]) {
      for (const profitOnWin of [0.7, 0.8, 0.9]) {
        const wins = id === "method-0" ? 80 : 50;
        ledger.push({ methodId: id, delayTicks, profitOnWin,
          segments: Array.from({ length: 4 }, () => ({ settledTrades: 100,
            averageProfitPerDollarStake: (wins * profitOnWin - (100 - wins)) / 100 })) });
      }
    }
  }
  const ranked = rankFiftyMethods(ledger, ids, [100, 100, 100, 100]);
  assert.equal(ranked.ranking.length, 50);
  assert.equal(ranked.ranking[0].methodId, "method-0");
  assert.equal(ranked.developmentPassCount, 1);
  const underpowered = rankFiftyMethods(ledger, ids);
  assert.equal(underpowered.developmentPassCount, 0);
});
