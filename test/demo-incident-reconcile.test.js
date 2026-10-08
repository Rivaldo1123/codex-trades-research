import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDemoIncidentEvidence,
  normalizeBrowserPurchase,
} from "../src/demo-incident-reconcile.js";

test("incident reconciliation accounts for terminal broker records without calling an order path", async () => {
  const calls = [];
  const client = {
    async getOpenContract(contractId) {
      calls.push(["contract", contractId]);
      return {
        buy_price: "1.00",
        contract_id: contractId,
        contract_type: "CALL",
        currency: "USD",
        date_settlement: 1_791_477_905,
        is_sold: 1,
        profit: "0.89",
        status: "won",
        underlying_symbol: "1HZ100V",
      };
    },
    async getPortfolio() {
      calls.push(["portfolio"]);
      return [];
    },
    async getStatement(options) {
      calls.push(["statement", options]);
      return {
        coverage: { complete: true, pages: 1, reason: "EXHAUSTED", rows: 1 },
        transactions: [{
          action_type: "buy",
          amount: "-1.00",
          contract_id: 7001,
          transaction_id: "8001",
          transaction_time: 1_791_477_600,
        }],
      };
    },
  };

  const result = await collectDemoIncidentEvidence({
    accountFingerprint: "a".repeat(64),
    client,
    dateFrom: 1_791_477_000,
    dateTo: 1_791_478_000,
    observedAtUtc: "2026-10-08T22:30:00.000Z",
  });

  assert.equal(result.classification, "BROKER_RECORDS_RECONCILED_UNBOUND_TO_BROWSER_CONFIG");
  assert.equal(result.incidentDisposition, "ABORTED_CONNECTIVITY_LOSS");
  assert.equal(result.summary.realizedProfit, 0.89);
  assert.deepEqual(calls.map(([name]) => name), ["portfolio", "statement", "contract"]);
  assert.equal(JSON.stringify(result).includes("buyProposal"), false);
});

test("incident reconciliation remains unresolved for open or uncovered contracts", async () => {
  const result = await collectDemoIncidentEvidence({
    accountFingerprint: "b".repeat(64),
    client: {
      async getOpenContract() {
        throw new Error("should not be called");
      },
      async getPortfolio() {
        return [{ contract_id: 99 }];
      },
      async getStatement() {
        return {
          coverage: { complete: false, reason: "PAGE_LIMIT_REACHED", rows: 0 },
          transactions: [],
        };
      },
    },
    dateFrom: 100,
    dateTo: 200,
  });

  assert.equal(result.classification, "UNRESOLVED_OR_OPEN");
  assert.equal(result.summary.openContracts, 1);
  assert.equal(result.summary.unresolvedItems, 2);
});

test("a covered purchase still remains unresolved while its contract is open", async () => {
  const result = await collectDemoIncidentEvidence({
    accountFingerprint: "c".repeat(64),
    client: {
      async getOpenContract(contractId) {
        return {
          buy_price: 1,
          contract_id: contractId,
          is_sold: 0,
          status: "open",
        };
      },
      async getPortfolio() {
        return [{ contract_id: 55 }];
      },
      async getStatement() {
        return {
          coverage: { complete: true, reason: "EXHAUSTED", rows: 1 },
          transactions: [{
            action_type: "buy",
            amount: -1,
            contract_id: 55,
            transaction_id: "56",
            transaction_time: 150,
          }],
        };
      },
    },
    dateFrom: 100,
    dateTo: 200,
  });

  assert.equal(result.classification, "UNRESOLVED_OR_OPEN");
  assert.equal(result.summary.unresolvedItems, 1);
  assert.match(result.unresolved[0].reason, /remains open/);
});

test("statement purchases reject null and malformed accounting fields", () => {
  assert.throws(() => normalizeBrowserPurchase({
    action_type: "buy",
    amount: null,
    contract_id: 1,
    transaction_id: "2",
    transaction_time: 3,
  }), /finite numeric/);
  assert.throws(() => normalizeBrowserPurchase({
    action_type: "sell",
    amount: 1,
    contract_id: 1,
    transaction_id: "2",
    transaction_time: 3,
  }), /only broker buy rows/);
});
