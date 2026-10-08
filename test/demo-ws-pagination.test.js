import assert from "node:assert/strict";
import test from "node:test";

import { DerivDemoClient } from "../src/demo-ws-client.js";

function row(id) {
  return {
    action_type: "buy",
    amount: -1,
    contract_id: 10_000 + id,
    transaction_id: id,
    transaction_time: 1_791_460_000 + id,
  };
}

function offlineClient(handler) {
  const client = new DerivDemoClient(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=offline",
  );
  client.request = handler;
  return client;
}

test("statement reconciliation exhausts bounded offset pages", async () => {
  const requests = [];
  const client = offlineClient(async (request) => {
    requests.push(request);
    const transactions = request.offset === 0
      ? Array.from({ length: 999 }, (_, index) => row(index + 1))
      : [row(1000), row(1001)];
    return { statement: { count: transactions.length, transactions } };
  });
  const result = await client.getStatement({
    dateFrom: 1_791_460_000,
    dateTo: 1_791_470_000,
    limit: 999,
  });
  assert.deepEqual(requests.map((request) => request.offset), [0, 999]);
  assert.equal(result.transactions.length, 1001);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.reason, "EXHAUSTED");
});

test("duplicate pages and page failures preserve incomplete coverage", async () => {
  const firstPage = Array.from({ length: 2 }, (_, index) => row(index + 1));
  const duplicate = offlineClient(async () => ({
    statement: { count: firstPage.length, transactions: firstPage },
  }));
  const duplicateResult = await duplicate.getStatement({
    dateFrom: 1_791_460_000,
    dateTo: 1_791_470_000,
    limit: 2,
    maxPages: 3,
  });
  assert.equal(duplicateResult.coverage.complete, false);
  assert.equal(duplicateResult.coverage.reason, "DUPLICATE_PAGE");

  let calls = 0;
  const failed = offlineClient(async () => {
    calls += 1;
    if (calls === 2) throw new Error("RateLimit");
    return { statement: { count: firstPage.length, transactions: firstPage } };
  });
  const failedResult = await failed.getStatement({
    dateFrom: 1_791_460_000,
    dateTo: 1_791_470_000,
    limit: 2,
    maxPages: 3,
  });
  assert.equal(failedResult.coverage.complete, false);
  assert.equal(failedResult.coverage.reason, "PAGINATION_REQUEST_FAILED");
  assert.equal(failedResult.coverage.rows, 2);
});

test("statement page count and row identity are mandatory", async () => {
  const missingCount = offlineClient(async () => ({ statement: { transactions: [] } }));
  await assert.rejects(
    missingCount.getStatement({ dateFrom: 1, dateTo: 2 }),
    /page coverage/,
  );
  const missingIdentity = offlineClient(async () => ({
    statement: { count: 1, transactions: [{ action_type: "buy" }] },
  }));
  await assert.rejects(
    missingIdentity.getStatement({ dateFrom: 1, dateTo: 2 }),
    /missing its identity/,
  );
});
