import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PUBLIC_ENDPOINT } from "../src/deriv-public.js";
import {
  analyzeDiscreteDistribution,
  buildFeasibilityCalculations,
  multiplierThresholdFromCommissionAmount,
  SKEW_STEP_DISTRIBUTIONS,
} from "../src/feasibility-calculations.js";
import {
  runRangeBreakReconciliationProbe,
  validateRangeBreakReconciliationEvidence,
} from "../src/range-break-reconciliation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function contractsResponse() {
  return {
    contracts_for: {
      available: [
        {
          contract_category: "multiplier",
          contract_type: "MULTUP",
          expiry_type: "no_expiry",
          max_contract_duration: "0",
          min_contract_duration: "0",
          multiplier_range: [20, 40, 60, 80, 100],
          underlying_symbol: "RB100",
        },
      ],
    },
    echo_req: { contracts_for: "RB100", req_id: 1 },
    msg_type: "contracts_for",
    req_id: 1,
  };
}

test("three-request reconciliation proves the same RB100 MULTUP conflict and saves no id", async () => {
  const requests = [];
  const client = {
    endpoint: PUBLIC_ENDPOINT,
    async connect() {},
    close() {},
    async request(request) {
      requests.push(request);
      if (request.contracts_for) return contractsResponse();
      if (request.multiplier === 20) {
        throw new Error(
          "Deriv API error ContractBuyValidationError: Multiplier is not in acceptable range. Accepts 400,1000,2000,3000,4000.",
        );
      }
      return {
        echo_req: { ...request, req_id: 3 },
        msg_type: "proposal",
        proposal: {
          ask_price: 1,
          commission: 0.02,
          id: "sensitive-proposal-id",
          longcode: "Test multiplier quote.",
          multiplier: 400,
          payout: 0,
          spot: 50_000,
          spot_time: 1_790_000_000,
        },
        req_id: 3,
      };
    },
  };
  const report = await runRangeBreakReconciliationProbe({
    accessedAtUtc: "2026-10-08T00:00:00.000Z",
    clientFactory: () => client,
  });
  assert.equal(report.classification, "SPECIFICATION_CONFLICT");
  assert.equal(report.requestBudget.requestsActuallyMade, 3);
  assert.equal(validateRangeBreakReconciliationEvidence(report).valid, true);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => !("buy" in request)));
  assert.doesNotMatch(JSON.stringify(report), /sensitive-proposal-id/);
});

test("reconciliation stops without retry after an unrelated proposal error", async () => {
  let calls = 0;
  const client = {
    endpoint: PUBLIC_ENDPOINT,
    async connect() {},
    close() {},
    async request(request) {
      calls += 1;
      if (request.contracts_for) return contractsResponse();
      throw new Error("Deriv API error RateLimit: limit reached");
    },
  };
  const report = await runRangeBreakReconciliationProbe({ clientFactory: () => client });
  assert.equal(calls, 2);
  assert.equal(report.classification, "UNRESOLVED_OR_EARLY_STOP");
  assert.equal(report.requestBudget.noRetries, true);
});

test("multiplier break-even keeps commission-unit ambiguity and excluded costs explicit", () => {
  const threshold = multiplierThresholdFromCommissionAmount({
    commissionAmount: 0.02,
    multiplier: 400,
    stake: 1,
  });
  assert.equal(threshold.notional, 400);
  assert.equal(threshold.rawReturnFraction, 0.00005);
  assert.equal(threshold.rawReturnPercent, 0.005);
  assert.equal(threshold.rawReturnBps, 0.5);
  assert.ok(threshold.unsupportedOrExcluded.includes("stop-out path and stake cap"));

  const report = buildFeasibilityCalculations();
  assert.equal(
    report.multiplierQuote.percentOfNotionalInterpretation.rawReturnBps,
    2,
  );
  assert.match(report.multiplierQuote.unitFinding, /conditional/);
});

test("published Skew Step section tables each sum to one and have zero raw mean", () => {
  for (const distribution of Object.values(SKEW_STEP_DISTRIBUTIONS)) {
    const analysis = analyzeDiscreteDistribution(distribution);
    assert.equal(analysis.probabilitiesValid, true);
    assert.ok(Math.abs(analysis.probabilitySum - 1) < 1e-12);
    assert.ok(Math.abs(analysis.expectedIncrement) < 1e-12);
    assert.ok(analysis.variance > 0);
  }
});

test("v2 matrix preserves distinct evidence labels and discloses protocol deviation", async () => {
  const matrix = JSON.parse(await readFile(path.join(
    projectRoot,
    "research",
    "feasibility",
    "evidence-blocker-matrix-v2-2026-10-08.json",
  ), "utf8"));
  assert.equal(matrix.decision.code, "NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS");
  assert.equal(matrix.decision.validatedEdge, false);
  assert.equal(matrix.priorSearch.classification, "TESTED_AND_FAILED");
  assert.equal(matrix.protocol.apiRequestsUsed, 3);
  assert.equal(matrix.protocol.apiRequestCapComplied, true);
  assert.equal(matrix.protocol.officialPageCapComplied, false);
  assert.equal(matrix.holdout.status, "NOT_ASSIGNED");

  const classifications = Object.fromEntries(matrix.directions.map((direction) => [
    direction.id,
    direction.classifications.map((item) => item.code),
  ]));
  assert.deepEqual(classifications["range-break-boundary-state"], [
    "SPECIFICATION_CONFLICT",
    "INSUFFICIENT_EXECUTION_DATA",
  ]);
  assert.ok(classifications["skew-step-distribution-and-conditional-dependence"]
    .includes("TESTED_AND_FAILED"));
  assert.deepEqual(classifications["drift-volatility-switch-regimes"], [
    "INSUFFICIENT_EXECUTION_DATA",
  ]);
  assert.ok(matrix.directions.every((direction) =>
    direction.boundedExperimentJustified === false));
});
