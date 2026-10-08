import assert from "node:assert/strict";
import test from "node:test";

import {
  runFallOnlySmaFlowBacktest,
  runRiseOnlySmaFlowBacktest,
} from "../src/browser-flow-backtest.js";

test("Rise-only browser flow trades qualifying SMA signals and scores payout", () => {
  const ticks = Array.from({ length: 300 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: 100 + index,
  }));
  const report = runRiseOnlySmaFlowBacktest(ticks);

  assert.equal(report.parameters.fastWindow, 10);
  assert.equal(report.parameters.slowWindow, 20);
  assert.ok(report.test.observations > 0);
  assert.equal(report.test.losses, 0);
  assert.equal(report.test.winRate, 1);
  assert.match(report.methodology.execution, /one contract/);
  assert.ok(
    Math.abs(
      report.test.netProfitPerDollarStake - report.test.observations * 0.9,
    ) < 1e-10,
  );
});

test("browser flow resets after gaps and does not inflate trades during open contracts", () => {
  const ticks = [
    ...Array.from({ length: 170 }, (_, index) => ({
      epoch: 1_700_000_000 + index,
      quote: 100 + index,
    })),
    ...Array.from({ length: 170 }, (_, index) => ({
      epoch: 1_700_000_172 + index,
      quote: 300 + index,
    })),
  ];
  const report = runRiseOnlySmaFlowBacktest(ticks, {
    entryDelayTicks: 1,
    fastWindow: 2,
    horizonTicks: 5,
    payoutOnLoss: -1,
    payoutOnWin: 0.9,
    slowWindow: 3,
  });
  assert.equal(report.input.gaps.length, 1);
  assert.ok(report.test.observations < report.input.ticks / 2);
});

test("Fall-only browser flow trades falling SMA signals and scores payout", () => {
  const ticks = Array.from({ length: 300 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: 1_000 - index,
  }));
  const report = runFallOnlySmaFlowBacktest(ticks);

  assert.equal(report.parameters.direction, "fall");
  assert.ok(report.test.observations > 0);
  assert.equal(report.test.losses, 0);
  assert.equal(report.test.winRate, 1);
});

test("browser flow scores the next-tick entry rather than the signal tick", () => {
  const ticks = Array.from({ length: 300 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: index % 2 === 0 ? 100 : 110,
  }));
  const report = runRiseOnlySmaFlowBacktest(ticks, {
    entryDelayTicks: 1,
    fastWindow: 1,
    horizonTicks: 1,
    payoutOnLoss: -1,
    payoutOnWin: 0.9,
    slowWindow: 2,
  });

  assert.ok(report.test.observations > 0);
  assert.equal(report.test.winRate, 1);
  assert.match(report.methodology.entryTiming, /following tick/);
});
