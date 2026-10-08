import assert from "node:assert/strict";
import test from "node:test";

import { reconcileUnresolvedDemoTrades } from "../src/demo-trade-state.js";

const now = new Date("2026-10-08T12:05:00.000Z");

test("restart reconciles a purchase whose response was lost after disconnect", async () => {
  const appended = [];
  const events = [
    {
      maximumLoss: 1,
      stage: "pending",
      startedAt: "2026-10-08T12:00:00.000Z",
      symbol: "1HZ100V",
      tradeId: "lost-response",
    },
    {
      stage: "uncertain",
      tradeId: "lost-response",
    },
  ];
  const client = {
    async getStatement() {
      return [
        {
          action_type: "buy",
          amount: -1,
          contract_id: 123456,
          description: "1HZ100V Rise",
          transaction_id: 88,
          transaction_time: 1_791_460_800,
        },
      ];
    },
    async getOpenContract(id) {
      assert.equal(id, 123456);
      return {
        buy_price: 1,
        contract_id: id,
        exit_spot: 101,
        exit_spot_time: 1_791_461_090,
        is_sold: 1,
        profit: 0.9,
        status: "won",
      };
    },
  };
  const result = await reconcileUnresolvedDemoTrades({
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
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() {
        return [];
      },
    },
    events: [
      {
        maximumLoss: 1,
        stage: "uncertain",
        startedAt: "2026-10-08T12:04:30.000Z",
        tradeId: "recent-timeout",
      },
    ],
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
        return [
          {
            action_type: "buy",
            amount: -1,
            transaction_id: 77,
            transaction_time: 1_791_461_080,
          },
        ];
      },
    },
    events: [
      {
        maximumLoss: 1,
        stage: "uncertain",
        startedAt: "2026-10-08T12:04:30.000Z",
        tradeId: "missing-contract-id",
      },
    ],
    now,
  });
  assert.equal(appended.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0].reason, /identity cannot be established/);
});

test("authoritative empty broker statement reconciles an old intent as not purchased", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    appendEvent: async (event) => appended.push(event),
    client: {
      async getStatement() {
        return [];
      },
    },
    events: [
      {
        maximumLoss: 1,
        stage: "pending",
        startedAt: "2026-10-08T11:00:00.000Z",
        tradeId: "old-intent",
      },
    ],
    now,
  });
  assert.equal(result.blockers.length, 0);
  assert.equal(appended[0].stage, "reconciled");
  assert.equal(appended[0].reconciliationStatus, "not_purchased");
});

test("restart blocks when a reconciled contract remains open", async () => {
  const appended = [];
  const result = await reconcileUnresolvedDemoTrades({
    appendEvent: async (event) => appended.push(event),
    client: {
      async getOpenContract() {
        return { buy_price: 1, contract_id: 999, is_sold: 0, profit: -0.1, status: "open" };
      },
    },
    events: [
      {
        contractId: 999,
        maximumLoss: 1,
        stage: "reconciled",
        startedAt: "2026-10-08T11:00:00.000Z",
        tradeId: "open",
      },
    ],
    now,
  });
  assert.equal(result.blockers.length, 1);
  assert.equal(appended[0].reconciliationStatus, "broker_confirmed_open");
});
