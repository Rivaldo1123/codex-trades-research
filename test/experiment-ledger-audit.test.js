import assert from "node:assert/strict";
import test from "node:test";

import {
  referenceScore,
  separateQualificationQuestions,
  validateExperimentLedgerRecord,
} from "../src/experiment-ledger-audit.js";
import { canonicalJson, sha256 } from "../src/strategy-search-config.js";

test("reference accounting treats gross payout and net profit distinctly", () => {
  const score = referenceScore({ wins: 6, losses: 4, ties: 1, trades: 10 }, 0.9);
  assert.ok(Math.abs(score.netProfit - 1.4) < 1e-12);
  assert.ok(Math.abs(score.averageProfitPerDollarStaked - 0.14) < 1e-12);
  assert.ok(Math.abs(score.profitFactor - 1.35) < 1e-12);
});

test("qualification audit keeps economic, stress, evidence, and operational failures separate", () => {
  const protocol = {
    acceptanceRules: { minimumBaseAverageProfitPerDollarStaked: 0.02 },
  };
  const result = separateQualificationQuestions({
    acceptanceFailures: [
      "stress_expectancy_below_minimum",
      "multiple_testing_adjusted_evidence_failed",
      "too_few_total_trades",
    ],
    base: { averageProfitPerDollarStaked: 0.01 },
  }, protocol);
  assert.equal(result.baseModel.lost, false);
  assert.equal(result.baseModel.missedPracticalThreshold, true);
  assert.equal(result.conservativeStress.missedPracticalThreshold, true);
  assert.equal(result.statisticalEvidence.multiplicityAdjustedEvidencePassed, false);
  assert.equal(result.operationalOrSample.minimumTotalTradesFailed, true);
});

test("ledger audit recognizes JSON null as a fail-closed no-trade minimum", () => {
  const configuration = { durationTicks: 1, family: "unconditional_baseline" };
  const empty = referenceScore({ wins: 0, losses: 0, ties: 0, trades: 0 }, 0.9);
  const protocol = {
    acceptanceRules: {
      basePayoutOnWin: 0.9,
      reportedSevereStressPayoutOnWin: 0.7,
      stressPayoutOnWin: 0.8,
    },
    evaluationWindows: [{ id: "window" }],
    parameterRanges: {
      entryDelayTicks: [1],
      profitPerDollarOnWin: [0.7, 0.8, 0.9],
    },
  };
  const checked = validateExperimentLedgerRecord({
    configuration,
    configurationHash: sha256(canonicalJson(configuration)),
    evaluation: {
      base: empty,
      minimumSevereStressAverageProfitPerDollarStaked: null,
      minimumStressAverageProfitPerDollarStaked: null,
      scenarios: [{
        counts: { wins: 0, losses: 0, ties: 0, trades: 0 },
        delayTicks: 1,
        payoutScores: {
          0.7: referenceScore({ wins: 0, losses: 0, ties: 0, trades: 0 }, 0.7),
          0.8: referenceScore({ wins: 0, losses: 0, ties: 0, trades: 0 }, 0.8),
          0.9: empty,
        },
        windowId: "window",
      }],
    },
    failed: false,
    family: "unconditional_baseline",
  }, protocol);
  assert.equal(checked.stressMinimumEncodedAsNull, true);
  assert.equal(checked.severeMinimumEncodedAsNull, true);
});
