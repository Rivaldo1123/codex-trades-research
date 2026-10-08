import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserLearningReport } from "../src/browser-learning.js";

test("browser learning aggregates only recorded demo transactions", () => {
  const report = createBrowserLearningReport([
    {
      variantId: "baseline",
      transactions: [
        { buyPrice: 1, profit: 0.9, timestamp: "2026-10-06T00:00:01Z" },
        { buyPrice: 1, profit: -1, timestamp: "2026-10-06T00:00:02Z" },
        { buyPrice: 1, profit: 0.9, timestamp: "2026-10-06T00:00:03Z" },
      ],
    },
  ]);
  assert.equal(report.totals.observations, 3);
  assert.equal(report.totals.wins, 2);
  assert.equal(report.totals.losses, 1);
  assert.equal(report.totals.winRate, 2 / 3);
  assert.ok(Math.abs(report.totals.netProfit - 0.8) < 1e-12);
  assert.equal(report.byVariant.baseline.runs, 1);
  assert.equal(report.byVariant.baseline.observations, 3);
  assert.equal(report.byVariant.baseline.winRate, 2 / 3);
  assert.equal(report.target.achieved, false);
});
