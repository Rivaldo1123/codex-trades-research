import assert from "node:assert/strict";
import test from "node:test";

import { assessDemoRisk } from "../src/demo-risk.js";
import { reconcileUnresolvedDemoTrades } from "../src/demo-trade-state.js";

const accountFingerprint = "a".repeat(64);
const strategyHash = "b".repeat(64);
const now = new Date("2026-10-08T12:05:00.000Z");

function uncertainTrade(overrides = {}) {
  const startedAt = overrides.startedAt ?? "2026-10-08T12:00:00.000Z";
  return {
    accountFingerprint,
    contractType: "CALL",
    currency: "USD",
    direction: "up",
    duration: 5,
    durationUnit: "t",
    eventAt: startedAt,
    maximumLoss: 1,
    stage: "pending",
    stake: 1,
    startedAt,
    strategyHash,
    symbol: "1HZ100V",
    tradeId: "intent-1",
    ...overrides,
  };
}

function uncertainSequence(overrides = {}) {
  const pending = uncertainTrade(overrides);
  return [
    pending,
    {
      accountFingerprint,
      eventAt: new Date(Date.parse(pending.startedAt) + 1_000).toISOString(),
      stage: "uncertain",
      strategyHash,
      tradeId: pending.tradeId,
    },
  ];
}

test("reconciliation never binds a same-price purchase with incompatible terms", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() {
        return [{
          action_type: "buy",
          amount: -1,
          contract_id: 7001,
          description: "Volatility 50 Index Falls",
          transaction_id: 8001,
          transaction_time: 1_791_460_800,
        }];
      },
      async getOpenContract() {
        return {
          account_id: 9,
          buy_price: "1",
          contract_id: 7001,
          contract_type: "PUT",
          currency: "USD",
          exit_spot: "99",
          exit_spot_time: 1_791_461_090,
          is_sold: 1,
          profit: "0.9",
          purchase_time: 1_791_460_800,
          status: "won",
          tick_count: 5,
          underlying_symbol: "R_50",
        };
      },
    },
    events: uncertainSequence(),
    now,
  });

  assert.equal(result.blockers.length, 1);
  assert.equal(appended.some((event) => event.stage === "settled"), false);
  assert.match(result.blockers[0].reason, /incompatible|cannot be established/i);
});

test("one verified statement row cannot override another identity-ambiguous candidate", async () => {
  const appended = [];
  const rows = [
    {
      action_type: "buy", amount: -1, contract_id: 7004,
      transaction_id: 8004, transaction_time: 1_791_460_800,
    },
    {
      action_type: "buy", amount: -1,
      transaction_id: 8005, transaction_time: 1_791_460_801,
    },
  ];
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() {
        return {
          coverage: { complete: true, pages: 1, reason: "EXHAUSTED", rows: 2 },
          transactions: rows,
        };
      },
      async getOpenContract(id) {
        assert.equal(id, 7004);
        return {
          buy_price: 1,
          contract_id: id,
          contract_type: "CALL",
          currency: "USD",
          is_sold: 1,
          profit: 0.9,
          status: "won",
          tick_count: 5,
          underlying_symbol: "1HZ100V",
        };
      },
    },
    events: uncertainSequence(),
    now,
  });

  assert.equal(appended.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0].reason, /Multiple broker purchases.*cannot be assigned/i);
});

test("null settlement profit remains unresolved instead of becoming zero", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: {
      async getOpenContract() {
        return {
          buy_price: "1",
          contract_id: 7002,
          contract_type: "CALL",
          currency: "USD",
          exit_spot: "99",
          exit_spot_time: 1_791_461_090,
          is_sold: 1,
          profit: null,
          purchase_time: 1_791_460_800,
          status: "lost",
          tick_count: 5,
          underlying_symbol: "1HZ100V",
        };
      },
    },
    events: [
      uncertainTrade(),
      {
        accountFingerprint,
        contractId: 7002,
        eventAt: "2026-10-08T12:00:01.000Z",
        reconciliationStatus: "broker_purchase_confirmed",
        stage: "reconciled",
        strategyHash,
        tradeId: "intent-1",
      },
    ],
    now,
  });

  assert.equal(result.blockers.length, 1);
  assert.equal(appended.some((event) => event.stage === "settled"), false);
  assert.match(result.blockers[0].reason, /profit|outcome/i);
});

test("a full single statement page cannot prove that a purchase did not occur", async () => {
  const appended = [];
  const rows = Array.from({ length: 999 }, (_, index) => ({
    action_type: "buy",
    amount: -2,
    contract_id: 10_000 + index,
    transaction_id: 20_000 + index,
    transaction_time: 1_791_460_700 + index,
  }));
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: { async getStatement() { return rows; } },
    events: uncertainSequence({ startedAt: "2026-10-08T10:00:00.000Z" }),
    now,
  });

  assert.equal(result.blockers.length, 1);
  assert.equal(appended.some((event) =>
    event.reconciliationStatus === "not_purchased"), false);
  assert.match(result.blockers[0].reason, /statement|complete|purchase/i);
});

test("realized daily loss uses settlement day while counts use entry day", () => {
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
  const risk = assessDemoRisk({
    config,
    events: [
      uncertainTrade({ startedAt: "2026-10-07T23:59:59.000Z",
        tradeId: "cross-midnight-loss" }),
      {
        accountFingerprint,
        contractId: 7003,
        eventAt: "2026-10-08T00:00:01.000Z",
        reconciliationStatus: "broker_purchase_confirmed",
        stage: "reconciled",
        strategyHash,
        tradeId: "cross-midnight-loss",
      },
      {
        accountFingerprint,
        closedAt: "2026-10-08T00:00:04.000Z",
        contractId: 7003,
        eventAt: "2026-10-08T00:00:04.000Z",
        performanceEligible: true,
        profit: -1,
        stage: "settled",
        status: "lost",
        strategyHash,
        tradeId: "cross-midnight-loss",
      },
    ],
    nextMaximumLoss: 1,
    now: new Date("2026-10-08T09:00:00.000Z"),
    openContracts: [],
  });

  assert.equal(risk.tradesToday, 0);
  assert.equal(risk.netProfitToday, -1);
  assert.equal(risk.dailyLoss, 1);
});
