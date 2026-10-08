import assert from "node:assert/strict";
import test from "node:test";

import { reconcileUnresolvedDemoTrades } from "../src/demo-trade-state.js";

const now = new Date("2026-10-08T12:05:00.000Z");
const accountFingerprint = "a".repeat(64);
const strategyHash = "b".repeat(64);

function intent(overrides = {}) {
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
    tradeId: "fixture",
    ...overrides,
  };
}

function uncertainEvents(overrides = {}) {
  const pending = intent(overrides);
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

function completeStatement(transactions) {
  return {
    coverage: { complete: true, pages: 1, reason: "EXHAUSTED", rows: transactions.length },
    transactions,
  };
}

test("restart reconciles a purchase whose response was lost after disconnect", async () => {
  const appended = [];
  const events = [
    intent({ stage: "pending", tradeId: "lost-response" }),
    {
      accountFingerprint,
      eventAt: "2026-10-08T12:00:01.000Z",
      stage: "uncertain",
      strategyHash,
      tradeId: "lost-response",
    },
  ];
  const client = {
    async getStatement() {
      return completeStatement([
        {
          action_type: "buy",
          amount: -1,
          contract_id: 123456,
          description: "1HZ100V Rise",
          transaction_id: 88,
          transaction_time: 1_791_460_800,
        },
      ]);
    },
    async getOpenContract(id) {
      assert.equal(id, 123456);
      return {
        buy_price: 1,
        contract_id: id,
        contract_type: "CALL",
        currency: "USD",
        exit_spot: 101,
        exit_spot_time: 1_791_461_090,
        is_sold: 1,
        profit: 0.9,
        status: "won",
        tick_count: 5,
        underlying_symbol: "1HZ100V",
      };
    },
  };
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client,
    events,
    now,
  });
  assert.equal(result.blockers.length, 0);
  assert.deepEqual(appended.map((event) => event.stage), ["reconciled", "settled"]);
  assert.equal(appended[0].contractId, 123456);
  assert.equal(appended[1].profit, 0.9);
});

test("restart blocks while an uncertain purchase cannot yet be established", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() { return completeStatement([]); },
    },
    events: uncertainEvents({ startedAt: "2026-10-08T12:04:30.000Z", tradeId: "recent-timeout" }),
    now,
  });
  assert.equal(appended.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0].reason, /not elapsed/);
});

test("restart blocks if a matching statement row lacks a contract identity", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() {
        return completeStatement([
          {
            action_type: "buy",
            amount: -1,
            transaction_id: 77,
            transaction_time: 1_791_461_080,
          },
        ]);
      },
    },
    accountFingerprint,
    events: uncertainEvents({ startedAt: "2026-10-08T12:04:30.000Z", tradeId: "missing-contract-id" }),
    now,
  });
  assert.equal(appended.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0].reason, /identity cannot be established/);
});

test("one complete empty statement keeps an old intent uncertain", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() { return completeStatement([]); },
    },
    accountFingerprint,
    events: [intent({ startedAt: "2026-10-08T11:00:00.000Z", tradeId: "old-intent" })],
    now,
  });
  assert.equal(result.blockers.length, 1);
  assert.equal(appended[0].stage, "uncertain");
  assert.equal(appended[0].reconciliationStatus, "statement_complete_no_match_observed");
});

test("a later second complete empty statement can establish not purchased", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    accountFingerprint,
    appendEvent: async (event) => appended.push(event),
    client: { async getStatement() { return completeStatement([]); } },
    events: [
      intent({ startedAt: "2026-10-08T11:00:00.000Z", tradeId: "twice-empty" }),
      {
        accountFingerprint,
        eventAt: "2026-10-08T11:05:00.000Z",
        noPurchaseEvidenceCount: 1,
        reconciliationStatus: "statement_complete_no_match_observed",
        stage: "uncertain",
        strategyHash,
        tradeId: "twice-empty",
      },
    ],
    now,
  });
  assert.equal(result.blockers.length, 0);
  assert.equal(appended[0].reconciliationStatus, "not_purchased");
});

test("restart blocks when a reconciled contract remains open", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    appendEvent: async (event) => appended.push(event),
    client: {
      async getOpenContract() {
        return {
          buy_price: 1,
          contract_id: 999,
          contract_type: "CALL",
          currency: "USD",
          is_sold: 0,
          profit: -0.1,
          status: "open",
          underlying_symbol: "1HZ100V",
        };
      },
    },
    accountFingerprint,
    events: [
      intent({ startedAt: "2026-10-08T11:00:00.000Z", tradeId: "open" }),
      {
        accountFingerprint,
        contractId: 999,
        eventAt: "2026-10-08T11:00:01.000Z",
        reconciliationStatus: "broker_purchase_confirmed",
        stage: "reconciled",
        strategyHash,
        tradeId: "open",
      },
    ],
    now,
  });
  assert.equal(result.blockers.length, 1);
  assert.equal(appended[0].reconciliationStatus, "broker_confirmed_open");
});
