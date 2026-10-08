import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserLearningReport,
  hashBrowserStrategyConfig,
} from "../src/browser-learning.js";

const strategyHash = hashBrowserStrategyConfig({ rule: "fixed", version: 1 });

function transaction(contractId, overrides = {}) {
  return {
    accountId: "VRTC-test-account",
    buyPrice: 1,
    contractId,
    profit: 0.9,
    status: "won",
    timestamp: `2026-10-06T00:00:${String(contractId).padStart(2, "0")}Z`,
    ...overrides,
  };
}

test("browser learning counts only validated identity-bound settlements", () => {
  const report = createBrowserLearningReport([
    {
      strategyHash,
      variantId: "baseline",
      transactions: [
        transaction(1),
        transaction(2, { profit: -1, status: "lost" }),
        transaction(3),
      ],
    },
  ]);
  assert.equal(report.evidenceAudit.status, "VALID");
  assert.equal(report.totals.observations, 3);
  assert.equal(report.totals.wins, 2);
  assert.equal(report.totals.losses, 1);
  assert.equal(report.byStrategyHash[strategyHash].observations, 3);
});

test("importing identical records repeatedly cannot increase evidence count", () => {
  const run = {
    strategyHash,
    variantId: "baseline",
    transactions: [transaction(1), transaction(2)],
  };
  const report = createBrowserLearningReport([run, structuredClone(run), structuredClone(run)]);
  assert.equal(report.evidenceAudit.inputRows, 6);
  assert.equal(report.evidenceAudit.duplicateRows, 4);
  assert.equal(report.totals.observations, 2);
});

test("conflicting account and contract duplicates are rejected entirely", () => {
  const report = createBrowserLearningReport([
    { strategyHash, variantId: "baseline", transactions: [transaction(1)] },
    {
      strategyHash,
      variantId: "baseline",
      transactions: [transaction(1, { profit: -1, status: "lost" })],
    },
  ]);
  assert.equal(report.evidenceAudit.status, "INVALID_CONFLICTING_IDENTITIES");
  assert.equal(report.evidenceAudit.conflictingIdentities, 1);
  assert.equal(report.totals.observations, 0);
});

test("legacy rows without account, contract, status and strategy identities do not count", () => {
  const report = createBrowserLearningReport([
    {
      variantId: "legacy",
      transactions: [{ buyPrice: 1, profit: 0.9, timestamp: "2026-10-06T00:00:01Z" }],
    },
  ]);
  assert.equal(report.evidenceAudit.status, "NO_VALID_SETTLEMENTS");
  assert.equal(report.evidenceAudit.rejectedRows, 1);
  assert.equal(report.totals.observations, 0);
});
