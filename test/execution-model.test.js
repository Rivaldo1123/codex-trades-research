import assert from "node:assert/strict";
import test from "node:test";

import {
  SIGNAL_RISE,
  deriveSmaSignals,
  replaySequentialSignals,
} from "../src/execution-model.js";

test("shared execution model enforces one-open-contract sequencing", () => {
  const ticks = Array.from({ length: 12 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: 100 + index,
  }));
  const signals = new Uint8Array(ticks.length).fill(SIGNAL_RISE);
  const result = replaySequentialSignals({
    captureTrades: true,
    delayTicks: 1,
    durationTicks: 2,
    fromEpoch: ticks[0].epoch,
    signals,
    ticks,
    toEpochExclusive: ticks.at(-1).epoch + 1,
  });
  assert.deepEqual(
    result.trades.map((trade) => trade.signalEpoch - ticks[0].epoch),
    [0, 4, 8],
  );
  assert.ok(
    result.trades.every(
      (trade, index, trades) =>
        index === 0 || trade.signalEpoch > trades[index - 1].settlementEpoch,
    ),
  );
});

test("five-tick timing uses the next tick as entry and the fifth later tick as exit", () => {
  const ticks = Array.from({ length: 8 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: 100 + index,
  }));
  const signals = new Uint8Array(ticks.length);
  signals[0] = SIGNAL_RISE;
  const result = replaySequentialSignals({
    captureTrades: true,
    delayTicks: 1,
    durationTicks: 5,
    fromEpoch: ticks[0].epoch,
    signals,
    ticks,
    toEpochExclusive: ticks.at(-1).epoch + 1,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryEpoch, ticks[0].epoch + 1);
  assert.equal(result.trades[0].settlementEpoch, ticks[0].epoch + 6);
});

test("shared execution model never crosses a genuine tick gap", () => {
  const ticks = [
    ...Array.from({ length: 8 }, (_, index) => ({
      epoch: 1_700_000_000 + index,
      quote: 100 + index,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      epoch: 1_700_000_010 + index,
      quote: 110 + index,
    })),
  ];
  const signals = new Uint8Array(ticks.length).fill(SIGNAL_RISE);
  const result = replaySequentialSignals({
    captureTrades: true,
    delayTicks: 1,
    durationTicks: 2,
    fromEpoch: ticks[0].epoch,
    signals,
    ticks,
    toEpochExclusive: ticks.at(-1).epoch + 1,
  });
  assert.equal(result.gaps.length, 1);
  assert.ok(
    result.trades.every(
      (trade) =>
        trade.settlementEpoch <= 1_700_000_007 ||
        trade.signalEpoch >= 1_700_000_010,
    ),
  );
});

test("SMA warm-up resets after gaps and protected split boundaries", () => {
  const ticks = [
    ...Array.from({ length: 6 }, (_, index) => ({
      epoch: 1_700_000_000 + index,
      quote: 100 + index,
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      epoch: 1_700_000_010 + index,
      quote: 110 + index,
    })),
  ];
  const { signals } = deriveSmaSignals({
    direction: "rise",
    fastWindow: 2,
    resetEpochs: [1_700_000_013],
    slowWindow: 3,
    ticks,
  });
  assert.equal(signals[6], 0);
  assert.equal(signals[7], 0);
  assert.equal(signals[8], SIGNAL_RISE);
  assert.equal(signals[9], 0);
  assert.equal(signals[10], 0);
  assert.equal(signals[11], SIGNAL_RISE);
});
