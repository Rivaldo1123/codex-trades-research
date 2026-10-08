import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRangeBreakObservationState,
  observationStateSummary,
  observeRangeBreakProposalCycles,
  observeRangeBreakTick,
  rangeBreakObservationProposalRequest,
  sanitizePublicObservation,
  validateRangeBreakObservationProtocol,
} from "../src/range-break-observer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocol = JSON.parse(await readFile(
  path.join(root, "research", "protocols", "range-break-observation-v2.json"),
  "utf8",
));

test("Range Break protocol is public, order-free, and bounded to 24 requests", () => {
  assert.equal(validateRangeBreakObservationProtocol(protocol), protocol);
  assert.equal(protocol.requestBudget.maximumTotalRequests, 18);
  assert.equal(protocol.authenticated, false);
  assert.equal(protocol.ordersAuthorized, false);
  assert.equal(protocol.proposalConnectionPolicy.maximumConnections, 6);
  assert.equal(protocol.proposalConnectionPolicy.retriesPerCycle, 0);
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

test("v1 remains valid evidence while v2 rejects an expanded connection policy", async () => {
  const v1 = JSON.parse(await readFile(
    path.join(root, "research", "protocols", "range-break-observation-v1.json"),
    "utf8",
  ));
  assert.equal(validateRangeBreakObservationProtocol(v1), v1);
  assert.throws(() => validateRangeBreakObservationProtocol({
    ...protocol,
    proposalConnectionPolicy: {
      ...protocol.proposalConnectionPolicy,
      maximumConnections: 7,
    },
  }), /connection policy/);
});

test("v1 live interruption is preserved as an engineering failure, not a strategy result", async () => {
  const audit = JSON.parse(await readFile(
    path.join(root, "research", "audits", "range-break-observer-v1-interruption-2026-10-08.json"),
    "utf8",
  ));
  assert.equal(audit.classification, "FAILED_OBSERVER_ENGINEERING_NOT_RESEARCH_RESULT");
  assert.equal(audit.strategyEvidenceEligible, false);
  assert.equal(audit.executionAuthorizedByThisRecord, false);
  assert.equal(audit.session.ordersPlaced, 0);
  assert.equal(audit.session.successfulProposalResponses, 2);
  assert.equal(audit.session.failedProposalSnapshots, 2);
  assert.equal(audit.supersededBy, "research/protocols/range-break-observation-v2.json");
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

test("v2 opens a fresh proposal client for each snapshot cycle without retrying", async () => {
  const controller = new AbortController();
  const state = createRangeBreakObservationState(protocol);
  const clients = [];
  const records = [];
  let requestNumber = 0;
  await observeRangeBreakProposalCycles({
    clientFactory() {
      const client = {
        closed: false,
        connected: false,
        async connect() {
          this.connected = true;
        },
        close() {
          this.closed = true;
        },
        async request(request, expectedType) {
          assert.equal(this.connected, true);
          requestNumber += 1;
          if (request.contracts_for) {
            return { msg_type: "contracts_for", contracts_for: { available: [] } };
          }
          if (state.proposalSnapshots === 3) controller.abort();
          return {
            msg_type: expectedType,
            proposal: { ask_price: 1, id: `quote-${requestNumber}` },
          };
        },
      };
      clients.push(client);
      return client;
    },
    now: () => "2026-10-08T22:41:00.000Z",
    protocol,
    signal: controller.signal,
    state,
    wait: async () => {},
    writeObservation: async (record) => records.push(record),
  });

  assert.equal(clients.length, 2);
  assert.equal(clients.every((client) => client.closed), true);
  assert.equal(state.proposalConnections, 2);
  assert.equal(state.proposalSnapshots, 4);
  assert.equal(state.proposalFailures, 0);
  assert.equal(records.filter((record) => record.type === "capability").length, 1);
  assert.equal(records.filter((record) => record.type === "indicative_proposal").length, 4);
  assert.equal(JSON.stringify(records).includes("quote-"), false);
});
