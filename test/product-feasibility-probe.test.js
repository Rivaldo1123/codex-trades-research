import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PUBLIC_ENDPOINT } from "../src/deriv-public.js";
import {
  runProductFeasibilityProbe,
  summarizeHistory,
  summarizeMultiplierProposal,
  validateProductFeasibilityEvidence,
} from "../src/product-feasibility-probe.js";

function contracts(symbol) {
  return {
    contracts_for: {
      available: ["MULTUP", "MULTDOWN"].map((contractType) => ({
        cancellation_range: [],
        contract_category: "multiplier",
        contract_type: contractType,
        expiry_type: "no_expiry",
        max_contract_duration: "0",
        min_contract_duration: "0",
        multiplier_range: [20, 40, 60, 80, 100],
        sentiment: contractType === "MULTUP" ? "up" : "down",
        underlying_symbol: symbol,
      })),
    },
    msg_type: "contracts_for",
  };
}

test("proposal summary derives a raw movement break-even and discards its id", () => {
  const result = summarizeMultiplierProposal({
    msg_type: "proposal",
    proposal: {
      ask_price: 1,
      commission: 0.02,
      id: "must-not-be-persisted",
      multiplier: 400,
      payout: 0,
      spot: 50_000,
      spot_time: 1_790_000_000,
    },
  }, { contract_type: "MULTUP", underlying_symbol: "RB100" });
  assert.equal(result.rawMoveBreakEvenBpsBeforeExitCosts, 0.5);
  assert.equal("id" in result, false);
});

test("history summary is descriptive and preserves its simulation warning", () => {
  const result = summarizeHistory([
    { epoch: 100, quote: 100 },
    { epoch: 101, quote: 100.01 },
    { epoch: 102, quote: 99.99 },
  ], 0.5);
  assert.deepEqual(result.cadenceSeconds, { 1: 2 });
  assert.equal(result.positiveMoves, 1);
  assert.equal(result.negativeMoves, 1);
  assert.match(result.warning, /not a historical multiplier return/);
});

test("bounded public probe records metadata disagreement without an order", async () => {
  const requests = [];
  const client = {
    endpoint: PUBLIC_ENDPOINT,
    async connect() {},
    close() {},
    async getActiveSymbols() {
      return [
        { market: "synthetic_index", name: "Range Break 100 Index", symbol: "RB100" },
        { market: "synthetic_index", name: "Range Break 200 Index", symbol: "RB200" },
      ];
    },
    async getTicksHistory() {
      return Array.from({ length: 1_000 }, (_, index) => ({
        epoch: 1_788_877_188 + index,
        quote: 50_000 + index % 2,
      }));
    },
    async request(payload, expectedType) {
      requests.push({ expectedType, payload });
      if (payload.contracts_for) return contracts(payload.contracts_for);
      if (payload.multiplier === 20) {
        throw new Error(
          "Deriv API error ContractBuyValidationError: Multiplier is not in acceptable range. Accepts 400,1000,2000,3000,4000.",
        );
      }
      return {
        msg_type: "proposal",
        proposal: {
          ask_price: 1,
          commission: 0.02,
          id: "not-saved",
          multiplier: payload.multiplier,
          payout: 0,
          spot: 50_000,
          spot_time: 1_790_000_000,
        },
      };
    },
  };
  const result = await runProductFeasibilityProbe({
    accessedAtUtc: "2026-10-08T00:00:00.000Z",
    clientFactory: () => client,
    wait: async () => {},
  });
  assert.equal(result.advertisedMultiplierProbe.accepted, false);
  assert.deepEqual(
    result.advertisedMultiplierProbe.proposalAcceptedMultipliersFromError,
    [400, 1000, 2000, 3000, 4000],
  );
  assert.equal(result.indicativeProposals.length, 4);
  assert.equal(result.historicalPointSample.status, "AVAILABLE_POINT_SAMPLE");
  assert.equal(result.requestBudget.boundedRequestsActuallyMade, 9);
  assert.ok(requests.every(({ payload }) => !("buy" in payload)));
  assert.doesNotMatch(JSON.stringify(result), /not-saved/);
});

test("public probe rejects an alternate endpoint", async () => {
  await assert.rejects(runProductFeasibilityProbe({
    clientFactory: () => ({ endpoint: `${PUBLIC_ENDPOINT}?otp=secret` }),
  }), /locked to the public endpoint/);
});

test("evidence validation rejects orders, quote identities, and break-even drift", async () => {
  const client = {
    endpoint: PUBLIC_ENDPOINT,
    async connect() {},
    close() {},
    async getActiveSymbols() {
      return [{ market: "synthetic_index", name: "Range Break 100 Index", symbol: "RB100" }];
    },
    async getTicksHistory() {
      return Array.from({ length: 1_000 }, (_, index) => ({
        epoch: 1_788_877_188 + index,
        quote: 50_000 + index % 2,
      }));
    },
    async request(payload) {
      if (payload.contracts_for) return contracts(payload.contracts_for);
      if (payload.multiplier === 20) {
        throw new Error(
          "Deriv API error ContractBuyValidationError: Multiplier is not in acceptable range. Accepts 400,1000,2000,3000,4000.",
        );
      }
      return {
        msg_type: "proposal",
        proposal: {
          ask_price: 1,
          commission: 0.02,
          multiplier: 400,
          payout: 0,
          spot: 50_000,
          spot_time: 1_790_000_000,
        },
      };
    },
  };
  const report = await runProductFeasibilityProbe({
    clientFactory: () => client,
    wait: async () => {},
  });
  assert.equal(validateProductFeasibilityEvidence(report).valid, true);

  assert.throws(() => validateProductFeasibilityEvidence({
    ...structuredClone(report),
    ordersAuthorized: true,
  }), /not public\/read-only/);

  const withIdentity = structuredClone(report);
  withIdentity.indicativeProposals[0].id = "quote-id";
  assert.throws(() => validateProductFeasibilityEvidence(withIdentity), /quote identity/);

  const withDrift = structuredClone(report);
  withDrift.indicativeProposals[0].rawMoveBreakEvenBpsBeforeExitCosts = 0.4;
  assert.throws(() => validateProductFeasibilityEvidence(withDrift), /inconsistent/);
});

test("saved feasibility decision keeps three hypotheses disarmed", async () => {
  const report = JSON.parse(await readFile(new URL(
    "../research/feasibility/product-capability-and-payout-feasibility-2026-10-08.json",
    import.meta.url,
  ), "utf8"));
  assert.equal(report.decision.code, "NONE_JUSTIFY_FURTHER_RESEARCH");
  assert.equal(report.decision.positiveResultStatus, "NO_POSITIVE_RESULT");
  assert.equal(report.directions.length, 3);
  assert.deepEqual(
    report.directions.map((direction) => direction.rankAmongConditionalMicroExperiments),
    [1, 2, 3],
  );
  assert.ok(report.directions.every((direction) =>
    !direction.status.includes("QUALIFIED")));
  assert.deepEqual(report.controls, {
    authenticated: false,
    collectorStartedOrResumed: false,
    largeSearchStarted: false,
    ordersPlaced: false,
    paidServicesUsed: false,
    directionsCompared: 3,
  });

  const rangeBreak = report.directions.find((direction) =>
    direction.id === "range-break-boundary-state");
  assert.equal(
    report.breakEvenModels.multiplier.pointQuoteInputs.commissionUsd /
      (report.breakEvenModels.multiplier.pointQuoteInputs.stakeUsd *
        report.breakEvenModels.multiplier.pointQuoteInputs.multiplier) * 10_000,
    rangeBreak.indicativePayoutAndBreakEven.rawBreakEvenBeforeExitCostsBps,
  );

  const skew = report.directions.find((direction) =>
    direction.id === "skew-step-distribution");
  const expectedStep = skew.indicativePayoutAndBreakEven.publishedSkew5UpDistribution
    .reduce((sum, outcome) => sum + outcome.move * outcome.probability, 0);
  assert.ok(Math.abs(expectedStep) < 1e-12);
  assert.equal(skew.indicativePayoutAndBreakEven.rawExpectedStepSkew5Up, 0);
});
