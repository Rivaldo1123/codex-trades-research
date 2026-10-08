import assert from "node:assert/strict";
import test from "node:test";

import {
  validateContractIdentity,
  validateSettlement,
} from "../src/demo-contract-validation.js";
import { createLearningReport, groupTrades } from "../src/demo-learning.js";
import { assessDemoRisk } from "../src/demo-risk.js";

const accountFingerprint = "a".repeat(64);
const strategyHash = "b".repeat(64);
const pending = {
  accountFingerprint,
  contractType: "CALL",
  currency: "USD",
  direction: "up",
  duration: 5,
  durationUnit: "t",
  eventAt: "2026-10-08T12:00:00.000Z",
  maximumLoss: 1,
  stage: "pending",
  startedAt: "2026-10-08T12:00:00.000Z",
  strategyHash,
  symbol: "1HZ100V",
  tradeId: "trade-1",
};
const intent = {
  ...pending,
  buyPrice: 1,
  contractId: 77,
  eventAt: "2026-10-08T12:00:01.000Z",
  reconciliationStatus: "broker_purchase_confirmed",
  stage: "reconciled",
};
const journalPrefix = [pending, intent];

function finalContract(overrides = {}) {
  return {
    buy_price: "1",
    contract_id: 77,
    contract_type: "CALL",
    currency: "USD",
    exit_spot: "101",
    exit_spot_time: 1_791_461_000,
    is_sold: 1,
    profit: "0.9",
    status: "won",
    tick_count: 5,
    underlying_symbol: "1HZ100V",
    ...overrides,
  };
}

test("strict settlement rejects null, blank, boolean, non-finite and mismatched values", () => {
  for (const profit of [null, "", "  ", true, false, "Infinity", Number.NaN]) {
    assert.throws(() => validateSettlement(finalContract({ profit }), intent), /profit/i);
  }
  assert.throws(() => validateSettlement(finalContract({ contract_id: 78 }), intent),
    /identity/i);
  assert.throws(() => validateSettlement(finalContract({ status: "lost", profit: 0 }), intent),
    /inconsistent/i);
  assert.throws(() => validateSettlement(finalContract({ status: "cancelled", profit: 0 }), intent),
    /refund evidence/i);
  assert.throws(() => validateContractIdentity(finalContract({
    duration: 5,
    duration_unit: undefined,
    tick_count: undefined,
  }), intent, { requireDurationEvidence: true }), /duration is unavailable/i);
});

test("early sales are accounted but excluded from strategy performance", () => {
  const settlement = validateSettlement(finalContract({
    profit: "-0.2",
    sell_price: "0.8",
    status: "sold",
  }), intent);
  assert.equal(settlement.outcomeKind, "early_sale");
  assert.equal(settlement.performanceEligible, false);
  const report = createLearningReport([
    ...journalPrefix,
    { ...settlement, accountFingerprint, eventAt: settlement.closedAt,
      stage: "settled", strategyHash, tradeId: intent.tradeId },
  ]);
  assert.equal(report.totals.settledTrades, 0);
});

test("duplicate settlements do not inflate results and conflicting ones fail closed", () => {
  const settled = {
    accountFingerprint,
    closedAt: "2026-10-08T12:01:00.000Z",
    contractId: 77,
    eventAt: "2026-10-08T12:01:00.000Z",
    performanceEligible: true,
    profit: 0.9,
    stage: "settled",
    status: "won",
    strategyHash,
    tradeId: intent.tradeId,
  };
  assert.equal(createLearningReport([...journalPrefix, settled, { ...settled }]).totals.settledTrades, 1);
  assert.throws(() => groupTrades([...journalPrefix, settled, { ...settled, profit: -1, status: "lost" }]),
    /Conflicting settlement/);
  assert.throws(() => groupTrades([
    ...journalPrefix,
    settled,
    { ...pending, eventAt: "2026-10-08T12:02:00.000Z", tradeId: "trade-2" },
    { ...intent, eventAt: "2026-10-08T12:02:01.000Z", tradeId: "trade-2" },
  ]), /multiple demo trades/);
});

test("corrections are unique and count on correction day without double counting", () => {
  const correctionPending = {
    ...pending,
    eventAt: "2026-10-07T23:58:00.000Z",
    startedAt: "2026-10-07T23:58:00.000Z",
  };
  const correctionIntent = {
    ...intent,
    eventAt: "2026-10-07T23:58:01.000Z",
    startedAt: "2026-10-07T23:58:00.000Z",
  };
  const settled = {
    accountFingerprint,
    closedAt: "2026-10-07T23:59:59.000Z",
    contractId: 77,
    eventAt: "2026-10-07T23:59:59.000Z",
    profit: -1,
    stage: "settled",
    status: "lost",
    strategyHash,
    tradeId: intent.tradeId,
  };
  const correction = {
    accountFingerprint,
    correctedAt: "2026-10-08T01:00:00.000Z",
    correctionId: "broker-correction-1",
    eventAt: "2026-10-08T01:00:00.000Z",
    profitAdjustment: 0.25,
    stage: "correction",
    strategyHash,
    tradeId: intent.tradeId,
  };
  const events = [correctionPending, correctionIntent, settled, correction, { ...correction }];
  const config = {
    executionEnabled: true,
    risk: { cooldownMinutes: 15, maxDailyLossDemoUsd: 5, maxOpenContracts: 1,
      maxTradesPerDay: 4, stakeDemoUsd: 1 },
  };
  const risk = assessDemoRisk({
    config,
    events,
    now: new Date("2026-10-08T09:00:00.000Z"),
    openContracts: [],
  });
  assert.equal(risk.netProfitToday, 0.25);
});

test("journal state and identity checks reject shortcut settlements", () => {
  const settled = {
    accountFingerprint,
    closedAt: "2026-10-08T12:01:00.000Z",
    contractId: 77,
    eventAt: "2026-10-08T12:01:00.000Z",
    performanceEligible: true,
    profit: 0.9,
    stage: "settled",
    status: "won",
    strategyHash,
    tradeId: intent.tradeId,
  };
  assert.throws(() => groupTrades([settled]), /must begin/i);
  assert.throws(() => groupTrades([pending, settled]), /pending -> settled|before.*reconciled/i);
  assert.throws(() => groupTrades([
    pending,
    { ...intent, accountFingerprint: undefined },
  ]), /account.*identity/i);
  assert.throws(() => groupTrades([
    ...journalPrefix,
    settled,
    { ...pending, eventAt: "2026-10-08T12:02:00.000Z" },
  ]), /Illegal.*transition/i);
});

test("documented numeric strings are normalized before risk accounting", () => {
  const settled = {
    accountFingerprint,
    closedAt: "2026-10-08T12:01:00.000Z",
    contractId: 77,
    eventAt: "2026-10-08T12:01:00.000Z",
    performanceEligible: true,
    profit: "-1",
    stage: "settled",
    status: "lost",
    strategyHash,
    tradeId: intent.tradeId,
  };
  const risk = assessDemoRisk({
    config: {
      executionEnabled: true,
      risk: { cooldownMinutes: 0, maxDailyLossDemoUsd: 5, maxOpenContracts: 1,
        maxTradesPerDay: 4, stakeDemoUsd: 1 },
    },
    events: [...journalPrefix, settled],
    now: new Date("2026-10-08T13:00:00.000Z"),
    openContracts: [],
  });
  assert.equal(risk.netProfitToday, -1);
  assert.equal(risk.dailyLoss, 1);
});
