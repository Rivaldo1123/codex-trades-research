import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRangeBreakObservationState,
  observationStateSummary,
  observeRangeBreakTick,
  rangeBreakObservationProposalRequest,
  sanitizePublicObservation,
  validateRangeBreakObservationProtocol,
} from "../src/range-break-observer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocol = JSON.parse(await readFile(
  path.join(root, "research", "protocols", "range-break-observation-v1.json"),
  "utf8",
));

test("Range Break protocol is public, order-free, and bounded to 24 requests", () => {
  assert.equal(validateRangeBreakObservationProtocol(protocol), protocol);
  assert.equal(protocol.requestBudget.maximumTotalRequests, 18);
  assert.equal(protocol.authenticated, false);
  assert.equal(protocol.ordersAuthorized, false);
  const request = rangeBreakObservationProposalRequest(protocol, "MULTUP");
  assert.deepEqual(request, {
    amount: 1,
    basis: "stake",
    contract_type: "MULTUP",
    currency: "USD",
    multiplier: 400,
    proposal: 1,
    underlying_symbol: "RB100",
  });
  assert.equal("buy" in request, false);
  assert.equal("sell" in request, false);
});

test("protocol validation rejects authentication, order authorization, and budget expansion", () => {
  assert.throws(
    () => validateRangeBreakObservationProtocol({ ...protocol, authenticated: true }),
    /public, unauthenticated, and order-free/,
  );
  assert.throws(
    () => validateRangeBreakObservationProtocol({ ...protocol, ordersAuthorized: true }),
    /public, unauthenticated, and order-free/,
  );
  assert.throws(
    () => validateRangeBreakObservationProtocol({
      ...protocol,
      requestBudget: { ...protocol.requestBudget, maximumTotalRequests: 25 },
    }),
    /request budget/,
  );
});

test("tick audit records cadence without inventing a one-second coverage requirement", () => {
  const state = createRangeBreakObservationState(protocol);
  observeRangeBreakTick(state, { epoch: 100, quote: 50_000 });
  observeRangeBreakTick(state, { epoch: 101, quote: 50_001 });
  observeRangeBreakTick(state, { epoch: 101, quote: 50_001 });
  observeRangeBreakTick(state, { epoch: 101, quote: 50_002 });
  observeRangeBreakTick(state, { epoch: 104, quote: 50_003 });
  const summary = observationStateSummary(state);
  assert.equal(summary.ticks, 5);
  assert.equal(summary.uniqueEpochs, 3);
  assert.equal(summary.duplicateSameEpoch, 1);
  assert.equal(summary.conflictingSameEpoch, 1);
  assert.deepEqual(summary.tickDeltaHistogram, { "0": 2, "1": 1, "3": 1 });
  assert.equal("missingSeconds" in summary, false);
});

test("sanitization removes transient quote IDs and rejects any order-bearing content", () => {
  assert.deepEqual(
    sanitizePublicObservation({
      msg_type: "proposal",
      proposal: { ask_price: 1, id: "secret-quote-id" },
      req_id: 3,
      subscription: { id: "sub" },
    }),
    { msg_type: "proposal", proposal: { ask_price: 1 } },
  );
  assert.throws(
    () => sanitizePublicObservation({ buy: "proposal-id" }),
    /forbidden order field buy/,
  );
});
