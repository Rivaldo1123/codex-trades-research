import { createHash } from "node:crypto";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";

const FORBIDDEN_ACTION_FIELDS = new Set([
  "authorize",
  "buy",
  "cancel",
  "sell",
  "sell_contract_for_multiple_accounts",
  "buy_contract_for_multiple_accounts",
]);
const REDACTED_FIELDS = new Set(["id", "req_id", "subscription"]);

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function assertNoOrderAction(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoOrderAction(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ACTION_FIELDS.has(key)) {
      throw new Error(`Observation payload contains forbidden order field ${key}.`);
    }
    assertNoOrderAction(child);
  }
}

export function sanitizePublicObservation(value) {
  assertNoOrderAction(value);
  if (Array.isArray(value)) return value.map(sanitizePublicObservation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REDACTED_FIELDS.has(key))
      .map(([key, child]) => [key, sanitizePublicObservation(child)]),
  );
}

export function validateRangeBreakObservationProtocol(protocol) {
  if (!protocol || protocol.schemaVersion !== 1 ||
      protocol.kind !== "range-break-observation-protocol") {
    throw new Error("Unsupported Range Break observation protocol.");
  }
  if (protocol.endpoint !== PUBLIC_ENDPOINT || protocol.authenticated !== false ||
      protocol.ordersAuthorized !== false) {
    throw new Error("Range Break observation must remain public, unauthenticated, and order-free.");
  }
  if (protocol.symbol !== "RB100") {
    throw new Error("The frozen observation protocol is limited to RB100.");
  }
  positiveInteger(protocol.durationSeconds, "Observation duration");
  positiveInteger(protocol.maximumTicks, "Maximum ticks");
  positiveInteger(protocol.maximumReconnects, "Maximum reconnects");
  positiveInteger(protocol.proposalIntervalSeconds, "Proposal interval");
  positiveInteger(protocol.maximumProposalSnapshots, "Maximum proposal snapshots");
  const terms = protocol.proposalTerms;
  if (terms?.amount !== 1 || terms?.basis !== "stake" || terms?.currency !== "USD" ||
      terms?.multiplier !== 400 ||
      JSON.stringify(terms?.contractTypes) !== JSON.stringify(["MULTUP", "MULTDOWN"])) {
    throw new Error("Range Break proposal terms differ from the frozen observation protocol.");
  }
  const budget = protocol.requestBudget;
  const expectedSubscriptions = protocol.maximumReconnects + 1;
  const expectedTotal = 1 + expectedSubscriptions + protocol.maximumProposalSnapshots;
  if (budget?.capabilityRequests !== 1 ||
      budget.maximumTickSubscriptionRequests !== expectedSubscriptions ||
      budget.maximumProposalRequests !== protocol.maximumProposalSnapshots ||
      budget.maximumTotalRequests !== expectedTotal ||
      expectedTotal > 24) {
    throw new Error("Range Break observation request budget is inconsistent or exceeds 24 requests.");
  }
  return protocol;
}

export function rangeBreakObservationProposalRequest(protocol, contractType) {
  validateRangeBreakObservationProtocol(protocol);
  if (!protocol.proposalTerms.contractTypes.includes(contractType)) {
    throw new Error("Unexpected Range Break observation contract type.");
  }
  return {
    amount: protocol.proposalTerms.amount,
    basis: protocol.proposalTerms.basis,
    contract_type: contractType,
    currency: protocol.proposalTerms.currency,
    multiplier: protocol.proposalTerms.multiplier,
    proposal: 1,
    underlying_symbol: protocol.symbol,
  };
}

export function createRangeBreakObservationState(protocol) {
  validateRangeBreakObservationProtocol(protocol);
  return {
    conflictingSameEpoch: 0,
    duplicateSameEpoch: 0,
    firstTickEpoch: null,
    lastTickEpoch: null,
    nonMonotonicTicks: 0,
    proposalFailures: 0,
    proposalSnapshots: 0,
    reconnects: 0,
    sourceDiscontinuities: 0,
    tickDeltaHistogram: {},
    ticks: 0,
    uniqueEpochs: 0,
    _lastQuote: null,
  };
}

export function observeRangeBreakTick(state, tick) {
  const epoch = Number(tick?.epoch);
  const quote = Number(tick?.quote);
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isFinite(quote)) {
    throw new Error("Range Break tick must have a valid epoch and finite quote.");
  }
  if (state.lastTickEpoch !== null) {
    const delta = epoch - state.lastTickEpoch;
    state.tickDeltaHistogram[String(delta)] =
      (state.tickDeltaHistogram[String(delta)] ?? 0) + 1;
    if (delta < 0) state.nonMonotonicTicks += 1;
    if (delta === 0) {
      if (quote === state._lastQuote) state.duplicateSameEpoch += 1;
      else state.conflictingSameEpoch += 1;
    } else if (delta > 0) {
      state.uniqueEpochs += 1;
    }
  } else {
    state.firstTickEpoch = epoch;
    state.uniqueEpochs = 1;
  }
  state.lastTickEpoch = epoch;
  state._lastQuote = quote;
  state.ticks += 1;
  return { epoch, quote };
}

export function observationStateSummary(state) {
  const {
    _lastQuote,
    ...summary
  } = state;
  return { ...summary };
}

export function observationHash(value) {
  return createHash("sha256").update(value).digest("hex");
}
