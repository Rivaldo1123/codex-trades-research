import { createHash } from "node:crypto";

import {
  rangeBreakObservationProposalRequest,
  sanitizePublicObservation,
  validateRangeBreakObservationProtocol,
} from "./range-break-observer.js";

const ALLOWED_RECORD_TYPES = new Set([
  "capability",
  "indicative_proposal",
  "proposal_cycle_failure",
  "session_end",
  "session_start",
  "source_discontinuity",
  "tick",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
}

function finiteNumber(value, label, { minimum = -Infinity } = {}) {
  if (value === null || value === undefined || typeof value === "boolean" ||
      (typeof value === "string" && value.trim() === "")) {
    throw new Error(`${label} is not numeric.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${label} is not numeric.`);
  }
  return parsed;
}

function safeEpoch(value, label) {
  const parsed = finiteNumber(value, label, { minimum: 1 });
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not an epoch.`);
  return parsed;
}

function structurallyEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJsonLines(rawBytes) {
  const text = Buffer.from(rawBytes).toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Range Break observation is empty.");
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Range Break observation line ${index + 1} is malformed JSON.`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        !ALLOWED_RECORD_TYPES.has(record.type)) {
      throw new Error(`Range Break observation line ${index + 1} has an invalid type.`);
    }
    // This recursively rejects authentication and order-bearing fields. The
    // returned sanitized value is not used because the immutable raw record is
    // the object being audited.
    sanitizePublicObservation(record);
    return record;
  });
}

function proposalTerms(record, protocol) {
  if (!protocol.proposalTerms.contractTypes.includes(record.contractType)) {
    throw new Error("Range Break proposal has an unexpected contract type.");
  }
  const expectedRequest = rangeBreakObservationProposalRequest(
    protocol,
    record.contractType,
  );
  if (!structurallyEqual(record.request, expectedRequest)) {
    throw new Error("Range Break proposal request differs from the frozen protocol.");
  }
  if (record.response?.msg_type !== "proposal" ||
      !record.response.proposal || record.response.error) {
    throw new Error("Range Break proposal response is not a successful proposal.");
  }
  const proposal = record.response.proposal;
  const multiplier = finiteNumber(proposal.multiplier, "Proposal multiplier", {
    minimum: 1,
  });
  if (multiplier !== protocol.proposalTerms.multiplier) {
    throw new Error("Range Break proposal multiplier differs from the request.");
  }
  const spot = finiteNumber(proposal.spot, "Proposal spot");
  const stopOut = finiteNumber(
    proposal.limit_order?.stop_out?.value,
    "Proposal stop-out value",
  );
  const askPrice = finiteNumber(proposal.ask_price, "Proposal ask price", {
    minimum: Number.MIN_VALUE,
  });
  const commission = finiteNumber(proposal.commission, "Proposal commission", {
    minimum: 0,
  });
  const payout = finiteNumber(proposal.payout, "Proposal payout", { minimum: 0 });
  return {
    askPrice,
    commission,
    contractType: record.contractType,
    multiplier,
    observedAtUtc: record.observedAtUtc,
    payout,
    spot,
    spotTime: safeEpoch(proposal.spot_time, "Proposal spot time"),
    stopOut,
    stopOutDistanceBasisPoints: Math.abs(stopOut - spot) / spot * 10_000,
  };
}

function capabilityTerms(record, protocol) {
  const available = record.response?.contracts_for?.available;
  if (!Array.isArray(available)) {
    throw new Error("Range Break capability response has no available contracts.");
  }
  const terms = {};
  for (const contractType of protocol.proposalTerms.contractTypes) {
    const item = available.find((candidate) =>
      candidate?.underlying_symbol === protocol.symbol &&
      candidate?.contract_type === contractType,
    );
    if (!item || !Array.isArray(item.multiplier_range) ||
        item.multiplier_range.some((value) => !Number.isFinite(Number(value)))) {
      throw new Error(`Range Break capability is missing ${contractType} multiplier terms.`);
    }
    terms[contractType] = {
      expiryType: item.expiry_type ?? null,
      maximumDuration: item.max_contract_duration ?? null,
      minimumDuration: item.min_contract_duration ?? null,
      multiplierRange: item.multiplier_range.map(Number),
    };
  }
  return terms;
}

function pricePathSummary(ticks) {
  const quotes = ticks.map((tick) => tick.quote);
  let positiveMoves = 0;
  let negativeMoves = 0;
  let zeroMoves = 0;
  let maximumAbsoluteTickMove = 0;
  let largestTickMove = null;
  for (let index = 1; index < ticks.length; index += 1) {
    const move = ticks[index].quote - ticks[index - 1].quote;
    if (move > 0) positiveMoves += 1;
    else if (move < 0) negativeMoves += 1;
    else zeroMoves += 1;
    if (Math.abs(move) > maximumAbsoluteTickMove) {
      maximumAbsoluteTickMove = Math.abs(move);
      largestTickMove = {
        basisPoints: move / ticks[index - 1].quote * 10_000,
        fromEpoch: ticks[index - 1].epoch,
        fromQuote: ticks[index - 1].quote,
        fromUtc: new Date(ticks[index - 1].epoch * 1_000).toISOString(),
        pointMove: move,
        toEpoch: ticks[index].epoch,
        toQuote: ticks[index].quote,
        toUtc: new Date(ticks[index].epoch * 1_000).toISOString(),
      };
    }
  }
  return {
    endingQuote: quotes.at(-1),
    maximumAbsoluteTickMove,
    largestTickMove,
    maximumQuote: Math.max(...quotes),
    minimumQuote: Math.min(...quotes),
    negativeMoves,
    netPointMove: quotes.at(-1) - quotes[0],
    positiveMoves,
    priceRangePoints: Math.max(...quotes) - Math.min(...quotes),
    startingQuote: quotes[0],
    zeroMoves,
  };
}

function independentTickAudit(state, tick) {
  const epoch = safeEpoch(tick?.epoch, "Observed tick epoch");
  const quote = finiteNumber(tick?.quote, "Observed tick quote");
  if (state.lastTickEpoch === null) {
    state.firstTickEpoch = epoch;
    state.uniqueEpochs = 1;
  } else {
    const delta = epoch - state.lastTickEpoch;
    state.tickDeltaHistogram[String(delta)] =
      (state.tickDeltaHistogram[String(delta)] ?? 0) + 1;
    if (delta < 0) state.nonMonotonicTicks += 1;
    if (delta === 0) {
      if (quote === state._lastQuote) state.duplicateSameEpoch += 1;
      else state.conflictingSameEpoch += 1;
    } else {
      state.uniqueEpochs += 1;
    }
  }
  state.lastTickEpoch = epoch;
  state._lastQuote = quote;
  state.ticks += 1;
  return { epoch, quote };
}

export function auditRangeBreakObservation({
  manifestBytes,
  protocolBytes,
  rawBytes,
}) {
  const protocol = validateRangeBreakObservationProtocol(
    json(protocolBytes, "Range Break observation protocol"),
  );
  const manifest = json(manifestBytes, "Range Break observation manifest");
  if (manifest?.schemaVersion !== 1 ||
      manifest.kind !== "range-break-observation-manifest" ||
      manifest.protocolId !== protocol.protocolId ||
      manifest.endpoint !== protocol.endpoint ||
      manifest.authenticated !== false ||
      manifest.ordersPlaced !== 0 ||
      manifest.classification !== "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION") {
    throw new Error("Range Break observation manifest violates the frozen safety boundary.");
  }
  if (manifest.protocolSha256 !== sha256(protocolBytes)) {
    throw new Error("Range Break observation protocol hash does not match the manifest.");
  }
  if (manifest.rawSha256 !== sha256(rawBytes)) {
    throw new Error("Range Break observation raw hash does not match the manifest.");
  }

  const records = parseJsonLines(rawBytes);
  const starts = records.filter((record) => record.type === "session_start");
  const ends = records.filter((record) => record.type === "session_end");
  if (starts.length !== 1 || ends.length !== 1 || records[0] !== starts[0] ||
      records.at(-1) !== ends[0] || starts[0].protocolId !== protocol.protocolId) {
    throw new Error("Range Break observation does not have one complete session envelope.");
  }
  if (ends[0].classification !== "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION") {
    throw new Error("Range Break observation end record overstates its evidence scope.");
  }
  const startedAt = Date.parse(starts[0].observedAtUtc);
  const endedAt = Date.parse(ends[0].observedAtUtc);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    throw new Error("Range Break observation timestamps are invalid.");
  }

  // This deliberately does not call the collector's tick accumulator. It is a
  // small second implementation used to catch collector-summary defects.
  const state = {
    conflictingSameEpoch: 0,
    duplicateSameEpoch: 0,
    firstTickEpoch: null,
    lastTickEpoch: null,
    nonMonotonicTicks: 0,
    proposalFailures: 0,
    proposalConnections: 0,
    proposalSnapshots: 0,
    reconnects: 0,
    sourceDiscontinuities: 0,
    tickDeltaHistogram: {},
    ticks: 0,
    uniqueEpochs: 0,
    _lastQuote: null,
  };
  const ticks = [];
  const proposals = [];
  const capabilityRecords = records.filter((record) => record.type === "capability");
  if (capabilityRecords.length !== 1) {
    throw new Error("Range Break observation must contain one capability response.");
  }
  const capability = capabilityTerms(capabilityRecords[0], protocol);
  for (const record of records) {
    if (record.type === "tick") {
      if (record.symbol !== protocol.symbol) {
        throw new Error("Range Break tick uses the wrong symbol.");
      }
      ticks.push(independentTickAudit(state, record.tick));
    } else if (record.type === "indicative_proposal") {
      proposals.push(proposalTerms(record, protocol));
      state.proposalSnapshots += 1;
    } else if (record.type === "proposal_cycle_failure") {
      state.proposalFailures += 1;
    } else if (record.type === "source_discontinuity") {
      state.sourceDiscontinuities += 1;
      state.reconnects += 1;
    }
  }
  if (ticks.length === 0 || proposals.length === 0) {
    throw new Error("Range Break observation lacks ticks or indicative proposals.");
  }
  const summary = { ...state };
  delete summary._lastQuote;
  // Successful v2 cycles contain exactly one quote for each direction. A
  // failure is also one attempted connection.
  summary.proposalConnections =
    proposals.length / protocol.proposalTerms.contractTypes.length +
    state.proposalFailures;
  if (!Number.isSafeInteger(summary.proposalConnections)) {
    throw new Error("Range Break proposal cycles are incomplete.");
  }
  if (!structurallyEqual(manifest.summary, summary) ||
      !structurallyEqual(ends[0].summary, summary)) {
    throw new Error("Range Break observation summary does not reproduce from raw records.");
  }
  const elapsedSeconds = (endedAt - startedAt) / 1_000;
  const boundedStopSatisfied =
    elapsedSeconds >= protocol.durationSeconds - 2 ||
    ticks.length >= protocol.maximumTicks;
  if (!boundedStopSatisfied || proposals.length !== protocol.maximumProposalSnapshots ||
      state.proposalFailures !== 0 || state.sourceDiscontinuities > protocol.maximumReconnects) {
    throw new Error("Range Break observation did not satisfy its bounded completion rules.");
  }

  const advertisedIncludesAccepted = Object.values(capability).every((item) =>
    item.multiplierRange.includes(protocol.proposalTerms.multiplier),
  );
  const uniqueCommissions = [...new Set(proposals.map((item) => item.commission))];
  const conditionalThresholds = uniqueCommissions.map((commission) => ({
    basisPointsIfCommissionIsAccountCurrency:
      commission /
      (protocol.proposalTerms.amount * protocol.proposalTerms.multiplier) *
      10_000,
    basisPointsIfCommissionIsPercentOfNotional: commission * 100,
    commissionField: commission,
    pointMoveRangeIfCommissionIsAccountCurrency: {
      maximum: Math.max(...proposals
        .filter((item) => item.commission === commission)
        .map((item) => item.spot * commission /
          (protocol.proposalTerms.amount * protocol.proposalTerms.multiplier))),
      minimum: Math.min(...proposals
        .filter((item) => item.commission === commission)
        .map((item) => item.spot * commission /
          (protocol.proposalTerms.amount * protocol.proposalTerms.multiplier))),
    },
  }));
  const requestAccounting = {
    capabilityRequests: capabilityRecords.length,
    proposalRequests: proposals.length,
    tickSubscriptionRequests: state.reconnects + 1,
  };
  requestAccounting.totalRequests = requestAccounting.capabilityRequests +
    requestAccounting.proposalRequests + requestAccounting.tickSubscriptionRequests;
  if (requestAccounting.totalRequests > protocol.requestBudget.maximumTotalRequests) {
    throw new Error("Range Break observation exceeded its frozen request budget.");
  }

  return {
    schemaVersion: 1,
    kind: "range-break-observation-assessment",
    protocolId: protocol.protocolId,
    sessionId: manifest.sessionId,
    artifacts: {
      manifestBytes: Buffer.byteLength(manifestBytes),
      manifestSha256: sha256(manifestBytes),
      protocolBytes: Buffer.byteLength(protocolBytes),
      protocolSha256: sha256(protocolBytes),
      rawBytes: Buffer.byteLength(rawBytes),
      rawSha256: sha256(rawBytes),
    },
    integrity: {
      independentStrategyRegeneration: false,
      independentTickSummaryCalculation: true,
      manifestMatchesRaw: true,
      manifestMatchesProtocol: true,
      rawSummaryReproduced: true,
      state: "VERIFIED_COMPLETE_OBSERVATION",
    },
    safety: {
      authenticated: false,
      demoExecutionAuthorized: false,
      ordersPlaced: 0,
      strategySearchAuthorized: false,
    },
    coverage: {
      elapsedSeconds,
      endedAtUtc: new Date(endedAt).toISOString(),
      proposalSnapshots: proposals.length,
      startedAtUtc: new Date(startedAt).toISOString(),
      tickSummary: manifest.summary,
    },
    requestAccounting: {
      ...requestAccounting,
      maximumPermitted: protocol.requestBudget.maximumTotalRequests,
      proposalConnections: summary.proposalConnections,
    },
    capability: {
      acceptedProposalMultiplier: protocol.proposalTerms.multiplier,
      advertisedIncludesAccepted,
      advertisedTerms: capability,
      contractTypes: [...protocol.proposalTerms.contractTypes],
      product: protocol.symbol,
    },
    indicativeEconomics: {
      askPrices: [...new Set(proposals.map((item) => item.askPrice))],
      commissionFields: uniqueCommissions,
      conditionalThresholds,
      payoutFields: [...new Set(proposals.map((item) => item.payout))],
      stopOutDistanceBasisPoints: {
        maximum: Math.max(...proposals.map((item) => item.stopOutDistanceBasisPoints)),
        minimum: Math.min(...proposals.map((item) => item.stopOutDistanceBasisPoints)),
      },
      warning: "The threshold is valid only if commission is denominated in account currency. It excludes exit valuation, spread, processing delay, slippage, rejection, and path-dependent stop-out effects.",
    },
    pricePathDiagnostic: pricePathSummary(ticks),
    officialSources: [
      {
        accessedOn: "2026-10-08",
        claim: "Range Break oscillates between boundaries and creates a new range after a break, with average frequencies based on 100 or 200 boundary hits; the page's indicator language is a product statement, not performance evidence.",
        url: "https://deriv.com/markets/derived-indices/synthetic-indices",
      },
      {
        accessedOn: "2026-10-08",
        claim: "contracts_for is an unauthenticated public capability endpoint.",
        url: "https://developers.deriv.com/docs/data/contracts-for/",
      },
      {
        accessedOn: "2026-10-08",
        claim: "proposal supplies an unauthenticated indicative contract proposal.",
        url: "https://developers.deriv.com/docs/trading/proposal/",
      },
      {
        accessedOn: "2026-10-08",
        claim: "proposal_open_contract requires authentication and an existing contract identity for contract-specific valuation fields.",
        url: "https://developers.deriv.com/comparison/proposal-open-contract/",
      },
      {
        accessedOn: "2026-10-08",
        claim: "The documented workflow purchases before monitoring proposal_open_contract.",
        url: "https://developers.deriv.com/docs/workflows/",
      },
      {
        accessedOn: "2026-10-08",
        claim: "Trading terms separately describe multiplier commission and Range Break CFD server-processing/next-tick exit treatment; they do not establish that the observed Options API multiplier has identical close mechanics.",
        url: "https://docs.deriv.com/tnc/trading-terms.pdf",
      },
    ],
    missingForNetReplay: [
      "observable upper/lower boundary, boundary-hit count, and reset state at decision time",
      "authoritative commission units and complete charging formula",
      "timestamped executable account entry quote and actual fill",
      "timestamped early-close/sell valuation across the holding path",
      "quote validity, rejection, and server processing-delay observations",
      "slippage and any spread or close-price adjustment",
      "actual stop-out, cancellation, correction, and settlement events",
    ],
    classifications: [
      ...(advertisedIncludesAccepted ? [] : ["SPECIFICATION_CONFLICT"]),
      "INSUFFICIENT_EXECUTION_DATA",
    ],
    stageDecisions: [
      {
        id: "public-capability-observation",
        state: "COMPLETED_AND_LOCALLY_VERIFIED",
      },
      {
        id: "cost-complete-shadow-profit-experiment",
        state: "NOT_RUN_STOP_CONDITION_INSUFFICIENT_EXECUTION_DATA",
      },
      {
        id: "range-break-strategy-implementation",
        state: "NOT_CREATED_NO_QUALIFIED_CANDIDATE",
      },
      {
        id: "operational-demo-check",
        state: "NOT_RUN_NOT_AUTHORIZED_AND_NO_CANDIDATE",
      },
      {
        id: "prospective-strategy-validation",
        state: "NOT_STARTED_NO_DEVELOPMENT_CANDIDATE",
      },
    ],
    decision: "NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT",
    conclusion: "The completed public observation verifies cadence, capability responses, and indicative entry proposals only. It cannot support a cost-complete replay, strategy qualification, or demo execution.",
  };
}

function display(value, digits = 4) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

export function renderRangeBreakObservationAssessmentMarkdown(assessment) {
  if (assessment?.kind !== "range-break-observation-assessment") {
    throw new Error("Cannot render an unsupported Range Break assessment.");
  }
  const advertised = Object.entries(assessment.capability.advertisedTerms)
    .map(([contractType, item]) =>
      `${contractType}: ${item.multiplierRange.join(", ")}x (${item.expiryType})`)
    .join("; ");
  const thresholds = assessment.indicativeEconomics.conditionalThresholds
    .map((item) => `${item.commissionField} -> ${display(
      item.basisPointsIfCommissionIsAccountCurrency,
    )} bp if account currency, or ${display(
      item.basisPointsIfCommissionIsPercentOfNotional,
    )} bp if it denotes a percentage of notional`)
    .join(", ");
  return `# Range Break public-observation completion assessment

Date: 2026-10-08<br>
Protocol: \`${assessment.protocolId}\`<br>
Session: \`${assessment.sessionId}\`<br>
Decision: **${assessment.decision}**

## Scope and integrity

This is a completed, unauthenticated public observation. It is not a strategy
backtest, a fill record, or a demo settlement trial. A second tick accumulator
independent of the collector reproduced the raw JSONL summary, and both
artifact hashes matched. This did not regenerate any strategy result. The
observer placed **zero orders** and does not authorize execution.

The raw session remains under the ignored local \`data/range-break-observer/\`
directory. A public checkout can inspect this compact assessment and its hashes,
but cannot independently recompute it without the exact raw file identified
below. Re-downloading ticks would create a different observation, not restore
the original evidence.

- elapsed: ${display(assessment.coverage.elapsedSeconds, 3)} seconds
- ticks: ${assessment.coverage.tickSummary.ticks} (${assessment.coverage.tickSummary.uniqueEpochs} unique epochs)
- proposal snapshots: ${assessment.coverage.proposalSnapshots}
- public API requests: ${assessment.requestAccounting.totalRequests} of at most ${assessment.requestAccounting.maximumPermitted}
- proposal failures: ${assessment.coverage.tickSummary.proposalFailures}
- tick-source discontinuities: ${assessment.coverage.tickSummary.sourceDiscontinuities}
- raw SHA-256: \`${assessment.artifacts.rawSha256}\`
- raw bytes: ${assessment.artifacts.rawBytes}
- protocol SHA-256: \`${assessment.artifacts.protocolSha256}\`
- manifest SHA-256: \`${assessment.artifacts.manifestSha256}\`

## What the observation established

Deriv documents Range Break as oscillating between upper and lower boundaries,
with a new range after a high or low break and average break frequencies tied
to 100 or 200 boundary hits. That is a product description, not evidence that
a public-data rule predicts the next move or earns more than its costs. The
observed API records expose neither boundary levels nor a live boundary-hit or
reset-state variable.

The public capability response advertised ${advertised}. The same RB100
public endpoint accepted ${assessment.capability.acceptedProposalMultiplier}x
${assessment.capability.contractTypes.join(" and ")} proposal requests. Because
the accepted multiplier is absent from the advertised ranges, the product
metadata remains a **SPECIFICATION_CONFLICT**.

All captured proposals had indicative ask prices
${assessment.indicativeEconomics.askPrices.join(", ")} and commission fields
${assessment.indicativeEconomics.commissionFields.join(", ")}. Because the
field's units remain unresolved, the two conditional calculations are:
${thresholds}.
For the observed spots, the account-currency interpretation requires a raw
favourable move of ${display(Math.min(...assessment.indicativeEconomics
  .conditionalThresholds.map((item) =>
    item.pointMoveRangeIfCommissionIsAccountCurrency.minimum)))} to
${display(Math.max(...assessment.indicativeEconomics.conditionalThresholds
  .map((item) => item.pointMoveRangeIfCommissionIsAccountCurrency.maximum)))}
index points merely to offset the opening commission. Neither interpretation
is an all-in break-even or a profitability claim. The proposal payout field was
${assessment.indicativeEconomics.payoutFields.join(", ")}: this no-expiry
multiplier is valued as an open position, not as a fixed-return five-minute
Rise/Fall contract.

The observed point path ranged from ${assessment.pricePathDiagnostic.minimumQuote}
to ${assessment.pricePathDiagnostic.maximumQuote}, a
${assessment.pricePathDiagnostic.priceRangePoints}-point span. It ended
${assessment.pricePathDiagnostic.netPointMove} points from its start. These are
price-path facts only; the largest or net move does not establish a tradeable
return. The largest adjacent-tick movement was
${assessment.pricePathDiagnostic.largestTickMove.pointMove} points
(${display(assessment.pricePathDiagnostic.largestTickMove.basisPoints)} bp) at
${assessment.pricePathDiagnostic.largestTickMove.toUtc}; observing a
break after it occurs does not make its direction predictable beforehand.

## Why the strategy experiment stops here

The public data does not contain:

${assessment.missingForNetReplay.map((item) => `- ${item}`).join("\n")}

The official Price Proposal endpoint provides an indicative proposal without
authentication. By contrast, Proposal Open Contract—the interface that reports
an open contract's bid/current value—requires authentication and an existing
contract identity. Deriv's trading terms define next-tick closing for Range
Break CFDs, but do not establish that the observed Options API multiplier has
identical close mechanics. Public midpoint ticks cannot reconstruct either
product's execution events.

Consequently the applicable labels are
**${assessment.classifications.join(" + ")}**. No point-path rule, offline
profit calculation, Bot XML, or new demo run is justified from this evidence.

Downstream stages therefore stop deterministically:

${assessment.stageDecisions.map((item) => `- ${item.id}: \`${item.state}\``).join("\n")}

## Finite next decision

Stop the Range Break strategy branch unless a legitimate source supplies a
timestamped executable entry, complete early-close valuation path, exact
commission units, and terminal contract accounting. The smallest legitimate
future step would be a separately authorized, fixed-term **demo
execution-economics calibration**, not strategy validation. Its sole purpose would be to
record proposal, purchase, open-contract valuation, close/settlement, delays,
and charges for a very small predefined set of contracts. Until that evidence
exists, implementation readiness remains blocked. The repository's
[non-authorizing draft](../protocols/range-break-execution-economics-calibration-draft-v1.json)
sets a two-contract maximum and cannot authorize or execute an order.

## Official sources checked 2026-10-08

- [Contracts For Symbol](https://developers.deriv.com/docs/data/contracts-for/): public capability metadata.
- [Synthetic Indices](https://deriv.com/markets/derived-indices/synthetic-indices): documented Range Break boundary mechanism and qualified indicator discussion.
- [Price Proposal](https://developers.deriv.com/docs/trading/proposal/): unauthenticated indicative contract proposal.
- [Proposal Open Contract](https://developers.deriv.com/comparison/proposal-open-contract/): authenticated contract-specific valuation fields.
- [Complete trading workflow](https://developers.deriv.com/docs/workflows/): purchase precedes open-contract monitoring.
- [Trading terms](https://docs.deriv.com/tnc/trading-terms.pdf): separately documented multiplier commission and Range Break CFD server-processing/next-tick treatment; product equivalence remains unverified.
`;
}
