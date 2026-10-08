import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BROWSER_GATE_POLICY,
  evaluateBrowserRunGate,
} from "../src/browser-run-gate.js";

const now = new Date("2026-10-07T00:00:00.000Z");

function flowReport({
  winRate = 0.55,
  averageProfitPerDollarStake = 0.045,
  direction,
} = {}) {
  return {
    input: { lastEpoch: 1_791_329_495 },
    parameters: { fastWindow: 10, horizonTicks: 1, slowWindow: 20, direction },
    test: {
      averageProfitPerDollarStake,
      losses: 2_700,
      netProfitPerDollarStake: averageProfitPerDollarStake * 6_000,
      observations: 6_000,
      winRate,
      wins: 3_300,
    },
  };
}

function browserReport({
  observations = 300,
  profitFactor = 1.8,
  lower = 0.61,
  wins = 200,
  losses = 100,
  grossWins = 180,
  grossLosses = 100,
} = {}) {
  return {
    totals: {
      grossLosses,
      grossWins,
      losses,
      observations,
      profitFactor,
      winRate: wins / observations,
      winRateWilson95: { lower, upper: 0.65 },
      wins,
    },
  };
}

test("browser run gate waits when the actual evidence is weak", () => {
  const result = evaluateBrowserRunGate({
    browserReport: browserReport({
      grossLosses: 20,
      grossWins: 21.6,
      losses: 20,
      observations: 44,
      profitFactor: 1.08,
      lower: 0.400662,
      wins: 24,
    }),
    flowBacktestReport: flowReport({
      averageProfitPerDollarStake: -0.0591,
      winRate: 0.495196,
    }),
    now,
  });

  assert.equal(result.decision, "WAIT");
  assert.equal(result.eligibleForSignalCheck, false);
  assert.deepEqual(result.failedRequirementCodes, [
    "browser_sample_size",
    "browser_confidence_above_break_even",
    "browser_profit_factor",
    "api_test_edge",
  ]);
  assert.ok(Math.abs(result.evidence.browser.breakEvenWinRate - 0.526315789) < 1e-8);
});

test("browser run gate can isolate one declared variant", () => {
  const fall = browserReport();
  const result = evaluateBrowserRunGate({
    browserReport: {
      byVariant: { "one-tick-fall-unconditional": fall.totals },
      totals: browserReport({ observations: 44 }).totals,
    },
    browserVariantId: "one-tick-fall-unconditional",
    flowBacktestReport: flowReport({ direction: "fall", winRate: 0.55 }),
    now,
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, minimumApiEdge: 0.005 },
  });

  assert.equal(result.decision, "READY_FOR_SIGNAL");
  assert.equal(result.modules.browserVariantId, "one-tick-fall-unconditional");
  assert.match(result.safeguards.contractDirection, /Fall only/);
});

test("browser run gate does not borrow settlements from another bot flow", () => {
  const result = evaluateBrowserRunGate({
    browserReport: {
      byVariant: { "one-tick-fall-unconditional": browserReport().totals },
      totals: browserReport().totals,
    },
    browserVariantId: "one-tick-fall-signal",
    flowBacktestReport: flowReport({ direction: "fall" }),
    now,
  });

  assert.equal(result.decision, "WAIT");
  assert.equal(result.evidence.browser.observations, null);
  assert.ok(result.failedRequirementCodes.includes("browser_sample_size"));
});

test("browser run gate only advances to the bot's internal signal check", () => {
  const result = evaluateBrowserRunGate({
    browserReport: browserReport(),
    flowBacktestReport: flowReport({ winRate: 0.55 }),
    now,
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, minimumApiEdge: 0.005 },
  });

  assert.equal(result.decision, "READY_FOR_SIGNAL");
  assert.equal(result.eligibleForSignalCheck, true);
  assert.equal(result.safeguards.automaticRepeat, false);
  assert.equal(result.safeguards.maximumContractsPerRun, 1);
});
