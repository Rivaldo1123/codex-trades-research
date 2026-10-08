import assert from "node:assert/strict";
import test from "node:test";

import { buildDemoDecision } from "../src/demo-bot.js";
import { createLearningReport } from "../src/demo-learning.js";
import { assessDemoRisk } from "../src/demo-risk.js";
import {
  DerivDemoClient,
  directionToContractType,
} from "../src/demo-ws-client.js";

const config = {
  executionEnabled: true,
  risk: {
    cooldownMinutes: 15,
    maxDailyLossDemoUsd: 5,
    maxOpenContracts: 1,
    maxTradesPerDay: 4,
  },
};

test("demo client rejects every non-demo endpoint", () => {
  assert.doesNotThrow(
    () =>
      new DerivDemoClient(
        "wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-time",
      ),
  );
  assert.throws(
    () =>
      new DerivDemoClient(
        "wss://api.derivws.com/trading/v1/options/ws/real?otp=one-time",
      ),
    /Safety lock/,
  );
});

test("directions map only to rise and fall demo contracts", () => {
  assert.equal(directionToContractType("up"), "CALL");
  assert.equal(directionToContractType("down"), "PUT");
  assert.throws(() => directionToContractType("sideways"));
});

test("demo decision records measurable signal separation", () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({
    close: 100 + index,
    epoch: index,
  }));
  const decision = buildDemoDecision(candles, {
    fastWindow: 5,
    slowWindow: 10,
  });
  assert.equal(decision.direction, "up");
  assert.equal(decision.contractType, "CALL");
  assert.ok(decision.separationBps > 0);
});

test("risk gate enforces open-position, daily, loss, and cooldown limits", () => {
  const now = new Date("2026-10-06T20:00:00.000Z");
  assert.equal(
    assessDemoRisk({ config, events: [], openContracts: [], now }).allowed,
    true,
  );
  assert.equal(
    assessDemoRisk({ config, events: [], openContracts: [{}], now }).allowed,
    false,
  );

  const events = Array.from({ length: 4 }, (_, index) => ({
    eventAt: `2026-10-06T1${index}:00:00.000Z`,
    profit: index === 0 ? -5 : 0,
    stage: "settled",
    startedAt: `2026-10-06T1${index}:00:00.000Z`,
    tradeId: `trade-${index}`,
  }));
  const risk = assessDemoRisk({ config, events, openContracts: [], now });
  assert.equal(risk.allowed, false);
  assert.equal(risk.dailyLoss, 5);
  assert.equal(risk.tradesToday, 4);
});

test("learning report uses settled forward-demo outcomes only", () => {
  const report = createLearningReport([
    { direction: "up", stage: "intent", tradeId: "one" },
    { profit: 0.8, stage: "settled", tradeId: "one" },
    { direction: "down", stage: "intent", tradeId: "two" },
    { profit: -1, stage: "settled", tradeId: "two" },
    { direction: "up", stage: "intent", tradeId: "open" },
  ]);
  assert.equal(report.totals.settledTrades, 2);
  assert.equal(report.totals.wins, 1);
  assert.equal(report.totals.losses, 1);
  assert.equal(report.totals.winRate, 0.5);
  assert.equal(report.automaticParameterChanges, false);
});
