import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BROWSER_GATE_POLICY,
  RETIRED_BROWSER_STRATEGY_HASH,
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
  strategyHash = RETIRED_BROWSER_STRATEGY_HASH,
} = {}) {
  const totals = {
    grossLosses,
    grossWins,
    losses,
    observations,
    profitFactor,
    winRate: wins / observations,
    winRateWilson95: { lower, upper: 0.65 },
    wins,
  };
  return {
    evidenceAudit: { conflictingIdentities: 0, status: "VALID", valid: true },
    byStrategyHash: { [strategyHash]: totals },
    totals,
  };
}

test("retired browser gate always waits under the default policy", () => {
  const result = evaluateBrowserRunGate({
    browserReport: browserReport(),
    flowBacktestReport: flowReport(),
    now,
  });
  assert.equal(result.decision, "WAIT");
  assert.ok(result.failedRequirementCodes.includes("legacy_gate_retired"));
});

test("browser run gate waits when enabled evidence is weak", () => {
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
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, enabled: true },
  });

  assert.equal(result.decision, "WAIT");
  assert.deepEqual(result.failedRequirementCodes, [
    "browser_sample_size",
    "browser_confidence_above_break_even",
    "browser_profit_factor",
    "api_test_edge",
  ]);
  assert.ok(Math.abs(result.evidence.browser.breakEvenWinRate - 0.526315789) < 1e-8);
});

test("browser run gate uses only the exact declared strategy hash", () => {
  const result = evaluateBrowserRunGate({
    browserReport: browserReport({ strategyHash: "a".repeat(64) }),
    browserVariantId: "one-tick-fall-signal",
    flowBacktestReport: flowReport({ direction: "fall" }),
    now,
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, enabled: true },
  });
  assert.equal(result.decision, "WAIT");
  assert.equal(result.evidence.browser.observations, null);
  assert.ok(result.failedRequirementCodes.includes("browser_sample_size"));
});

test("conflicting duplicate evidence fails the integrity gate", () => {
  const report = browserReport();
  report.evidenceAudit = {
    conflictingIdentities: 1,
    status: "INVALID_CONFLICTING_IDENTITIES",
    valid: false,
  };
  const result = evaluateBrowserRunGate({
    browserReport: report,
    flowBacktestReport: flowReport(),
    now,
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, enabled: true, minimumApiEdge: 0.005 },
  });
  assert.equal(result.decision, "WAIT");
  assert.ok(result.failedRequirementCodes.includes("browser_evidence_integrity"));
});

test("enabled evaluator can advance only to an internal signal check", () => {
  const result = evaluateBrowserRunGate({
    browserReport: browserReport(),
    flowBacktestReport: flowReport({ direction: "fall", winRate: 0.55 }),
    now,
    policy: { ...DEFAULT_BROWSER_GATE_POLICY, enabled: true, minimumApiEdge: 0.005 },
  });
  assert.equal(result.decision, "READY_FOR_SIGNAL");
  assert.equal(result.eligibleForSignalCheck, true);
  assert.equal(result.modules.expectedStrategyHash, RETIRED_BROWSER_STRATEGY_HASH);
  assert.equal(result.safeguards.automaticRepeat, false);
  assert.equal(result.safeguards.maximumContractsPerRun, 1);
});
