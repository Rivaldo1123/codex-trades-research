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
    stakeDemoUsd: 1,
  },
};
const accountFingerprint = "a".repeat(64);
const strategyHash = "b".repeat(64);

function pendingTrade({
  direction = "up",
  startedAt,
  tradeId,
} = {}) {
  return {
    accountFingerprint,
    contractType: direction === "up" ? "CALL" : "PUT",
    currency: "USD",
    direction,
    duration: 5,
    durationUnit: "t",
    eventAt: startedAt,
    maximumLoss: 1,
    stage: "pending",
    stake: 1,
    startedAt,
    strategyHash,
    symbol: "1HZ100V",
    tradeId,
  };
}

function settledTrade({ closedAt, contractId, direction = "up", profit, startedAt, tradeId }) {
  const status = profit > 0 ? "won" : "lost";
  return [
    pendingTrade({ direction, startedAt, tradeId }),
    {
      accountFingerprint,
      contractId,
      eventAt: startedAt,
      reconciliationStatus: "broker_purchase_confirmed",
      stage: "reconciled",
      strategyHash,
      tradeId,
    },
    {
      accountFingerprint,
      closedAt: closedAt ?? startedAt,
      contractId,
      eventAt: closedAt ?? startedAt,
      performanceEligible: true,
      profit,
      stage: "settled",
      status,
      strategyHash,
      tradeId,
    },
  ];
}

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

test("low-level demo client cannot bypass the deployment executor", async () => {
  const client = new DerivDemoClient(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-time",
  );
  assert.throws(
    () => client.request({ buy: "p".repeat(32), price: 1 }, "buy"),
    /qualified executor path/,
  );
  await assert.rejects(
    client.buyProposal("p".repeat(32), 1),
    /lacks deployment authorization/,
  );
  await assert.rejects(
    client.buyProposal("p".repeat(32), 1, {
      candidateId: "none",
      config: {},
      executorSourceSha256: "0".repeat(64),
      projectRoot: process.cwd(),
      strategyHash: "0".repeat(64),
    }),
    /no candidate is qualified/,
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

test("demo decision excludes a still-forming candle", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  const nowEpoch = Math.floor(now.getTime() / 1_000);
  const candles = [
    { close: 100, epoch: nowEpoch - 180 },
    { close: 101, epoch: nowEpoch - 120 },
    { close: 102, epoch: nowEpoch - 60 },
    { close: 999, epoch: nowEpoch },
  ];
  const decision = buildDemoDecision(candles, {
    fastWindow: 2,
    granularitySeconds: 60,
    slowWindow: 3,
  }, { now });
  assert.equal(decision.candleEpoch, nowEpoch - 60);
  assert.equal(decision.close, 102);
});

test("demo decision cannot cross a candle gap or use a stale completed candle", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  const nowEpoch = Math.floor(now.getTime() / 1_000);
  const strategy = { fastWindow: 2, granularitySeconds: 60, slowWindow: 3 };
  assert.throws(() => buildDemoDecision([
    { close: 100, epoch: nowEpoch - 240 },
    { close: 101, epoch: nowEpoch - 180 },
    { close: 102, epoch: nowEpoch - 60 },
  ], strategy, { now }), /contiguous completed/);
  assert.throws(() => buildDemoDecision([
    { close: 100, epoch: nowEpoch - 240 },
    { close: 101, epoch: nowEpoch - 180 },
    { close: 102, epoch: nowEpoch - 120 },
  ], strategy, { now }), /stale/);
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

  const profits = [-5, 1, -0.5, -0.5];
  const events = Array.from({ length: 4 }, (_, index) => settledTrade({
    contractId: 100 + index,
    profit: profits[index],
    startedAt: `2026-10-06T1${index}:00:00.000Z`,
    tradeId: `trade-${index}`,
  })).flat();
  const risk = assessDemoRisk({ config, events, openContracts: [], now });
  assert.equal(risk.allowed, false);
  assert.equal(risk.dailyLoss, 5);
  assert.equal(risk.tradesToday, 4);
});

test("cooldown uses the latest relevant trade across a UTC date boundary", () => {
  const risk = assessDemoRisk({
    config,
    events: settledTrade({
      contractId: 200,
      profit: 0.9,
      startedAt: "2026-10-06T23:59:00.000Z",
      tradeId: "cross-midnight",
    }),
    openContracts: [],
    now: new Date("2026-10-07T00:05:00.000Z"),
  });
  assert.equal(risk.tradesToday, 0);
  assert.equal(risk.dailyLimitTimezone, "UTC");
  assert.equal(risk.cooldownRemainingSeconds, 540);
  assert.ok(risk.reasons.includes("The demo cooldown has not elapsed."));
});

test("risk reserves the next maximum loss and permits the exact loss boundary", () => {
  const events = settledTrade({
    contractId: 300,
    profit: -4,
    startedAt: "2026-10-06T18:00:00.000Z",
    tradeId: "loss",
  });
  const atBoundary = assessDemoRisk({
    config,
    events,
    nextMaximumLoss: 1,
    openContracts: [],
    now: new Date("2026-10-06T20:00:00.000Z"),
  });
  assert.equal(atBoundary.projectedDailyLoss, 5);
  assert.equal(atBoundary.allowed, true);

  const overBoundary = assessDemoRisk({
    config,
    events,
    nextMaximumLoss: 1.01,
    openContracts: [],
    now: new Date("2026-10-06T20:00:00.000Z"),
  });
  assert.equal(overBoundary.allowed, false);
  assert.match(overBoundary.reasons.join(" "), /would exceed/);
});

test("pending and uncertain outcomes reserve exposure and block another run", () => {
  const risk = assessDemoRisk({
    config,
    events: [
      pendingTrade({
        startedAt: "2026-10-06T19:50:00.000Z",
        tradeId: "unknown",
      }),
      {
        accountFingerprint,
        eventAt: "2026-10-06T19:50:01.000Z",
        stage: "uncertain",
        strategyHash,
        tradeId: "unknown",
      },
    ],
    nextMaximumLoss: 1,
    openContracts: [],
    now: new Date("2026-10-06T20:10:00.000Z"),
  });
  assert.equal(risk.reservedPendingLoss, 1);
  assert.equal(risk.unresolvedTrades, 1);
  assert.equal(risk.allowed, false);
  assert.match(risk.reasons.join(" "), /must be reconciled/);
});

test("learning report uses settled forward-demo outcomes only", () => {
  const report = createLearningReport([
    ...settledTrade({ contractId: 401, direction: "up", profit: 0.8,
      startedAt: "2026-10-06T10:00:00.000Z", tradeId: "one" }),
    ...settledTrade({ contractId: 402, direction: "down", profit: -1,
      startedAt: "2026-10-06T11:00:00.000Z", tradeId: "two" }),
    pendingTrade({ startedAt: "2026-10-06T12:00:00.000Z", tradeId: "open" }),
  ]);
  assert.equal(report.totals.settledTrades, 2);
  assert.equal(report.totals.wins, 1);
  assert.equal(report.totals.losses, 1);
  assert.equal(report.totals.winRate, 0.5);
  assert.equal(report.automaticParameterChanges, false);
});
