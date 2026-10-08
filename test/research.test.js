import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSignals,
  createResearchReport,
  simpleMovingAverage,
} from "../src/research.js";

test("simpleMovingAverage emits null until its window is full", () => {
  assert.deepEqual(simpleMovingAverage([1, 2, 3, 4], 3), [null, null, 2, 3]);
});

test("buildSignals classifies a rising series as up", () => {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    close: index + 1,
    epoch: index,
  }));
  const signals = buildSignals(candles, 2, 4);
  assert.equal(signals.at(-1).signal, "up");
});

test("research report keeps testing observations separate", () => {
  const candles = Array.from({ length: 120 }, (_, index) => ({
    close: 100 + index + Math.sin(index / 3),
    epoch: 1_700_000_000 + index * 60,
  }));
  const report = createResearchReport(candles, {
    fastWindow: 5,
    slowWindow: 10,
  });

  assert.equal(report.methodology.split, "Chronological 70% training / 30% testing");
  assert.ok(report.training.observations > 0);
  assert.ok(report.testing.observations > 0);
  assert.match(report.disclaimer, /not a trade instruction/i);
});
