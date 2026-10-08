import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditRangeBreakObservation,
  renderRangeBreakObservationAssessmentMarkdown,
} from "../src/range-break-observation-audit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolBytes = await readFile(path.join(
  root,
  "research",
  "protocols",
  "range-break-observation-v2.json",
));
const protocol = JSON.parse(protocolBytes);
const calibrationDraft = JSON.parse(await readFile(path.join(
  root,
  "research",
  "protocols",
  "range-break-execution-economics-calibration-draft-v1.json",
)));
const trackedInventory = JSON.parse(await readFile(path.join(
  root,
  "research",
  "reproducibility",
  "range-break-observation-v2-artifact-inventory.json",
)));

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture({ advertised = [20, 40, 60, 80, 100] } = {}) {
  const start = "2026-10-08T00:00:00.000Z";
  const end = "2026-10-08T01:00:00.000Z";
  const tickState = {
    conflictingSameEpoch: 0,
    duplicateSameEpoch: 0,
    firstTickEpoch: 100,
    lastTickEpoch: 102,
    nonMonotonicTicks: 0,
    proposalFailures: 0,
    proposalConnections: 6,
    proposalSnapshots: 12,
    reconnects: 0,
    sourceDiscontinuities: 0,
    tickDeltaHistogram: { "1": 2 },
    ticks: 3,
    uniqueEpochs: 3,
  };
  const available = protocol.proposalTerms.contractTypes.map((contractType) => ({
    contract_type: contractType,
    expiry_type: "no_expiry",
    max_contract_duration: "0",
    min_contract_duration: "0",
    multiplier_range: advertised,
    underlying_symbol: protocol.symbol,
  }));
  const records = [
    { observedAtUtc: start, protocolId: protocol.protocolId, type: "session_start" },
    {
      observedAtUtc: start,
      response: { contracts_for: { available }, msg_type: "contracts_for" },
      type: "capability",
    },
  ];
  for (let cycle = 0; cycle < 6; cycle += 1) {
    for (const contractType of protocol.proposalTerms.contractTypes) {
      const up = contractType === "MULTUP";
      records.push({
        contractType,
        observedAtUtc: start,
        request: {
          amount: 1,
          basis: "stake",
          contract_type: contractType,
          currency: "USD",
          multiplier: 400,
          proposal: 1,
          underlying_symbol: "RB100",
        },
        response: {
          msg_type: "proposal",
          proposal: {
            ask_price: 1,
            commission: 0.02,
            limit_order: { stop_out: { value: up ? "99.75" : "100.25" } },
            multiplier: 400,
            payout: 0,
            spot: 100,
            spot_time: 100,
          },
        },
        type: "indicative_proposal",
      });
    }
  }
  for (const [epoch, quote] of [[100, 100], [101, 101], [102, 100]]) {
    records.push({ observedAtUtc: start, symbol: "RB100", tick: { epoch, quote }, type: "tick" });
  }
  records.push({
    classification: "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION",
    observedAtUtc: end,
    summary: tickState,
    type: "session_end",
  });
  const rawBytes = Buffer.from(`${records.map(JSON.stringify).join("\n")}\n`);
  const manifest = {
    authenticated: false,
    classification: "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION",
    endpoint: protocol.endpoint,
    kind: "range-break-observation-manifest",
    ordersPlaced: 0,
    protocolId: protocol.protocolId,
    protocolSha256: hash(protocolBytes),
    rawFile: "fixture.jsonl",
    rawSha256: hash(rawBytes),
    schemaVersion: 1,
    sessionId: "fixture",
    summary: tickState,
  };
  return {
    manifest,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
    rawBytes,
  };
}

test("completed observation reproduces raw summary but remains ineligible for profit testing", () => {
  const input = fixture();
  const result = auditRangeBreakObservation({
    manifestBytes: input.manifestBytes,
    protocolBytes,
    rawBytes: input.rawBytes,
  });
  assert.equal(result.integrity.state, "VERIFIED_COMPLETE_OBSERVATION");
  assert.equal(result.integrity.independentTickSummaryCalculation, true);
  assert.equal(result.integrity.independentStrategyRegeneration, false);
  assert.equal(result.safety.ordersPlaced, 0);
  assert.equal(result.safety.strategySearchAuthorized, false);
  assert.deepEqual(result.requestAccounting, {
    capabilityRequests: 1,
    maximumPermitted: 18,
    proposalConnections: 6,
    proposalRequests: 12,
    tickSubscriptionRequests: 1,
    totalRequests: 14,
  });
  assert.deepEqual(result.classifications, [
    "SPECIFICATION_CONFLICT",
    "INSUFFICIENT_EXECUTION_DATA",
  ]);
  assert.equal(result.capability.advertisedIncludesAccepted, false);
  assert.equal(result.indicativeEconomics.conditionalThresholds[0]
    .basisPointsIfCommissionIsAccountCurrency, 0.5);
  assert.equal(result.indicativeEconomics.conditionalThresholds[0]
    .basisPointsIfCommissionIsPercentOfNotional, 2);
  assert.equal(result.indicativeEconomics.conditionalThresholds[0]
    .pointMoveRangeIfCommissionIsAccountCurrency.minimum, 0.005);
  assert.deepEqual(result.indicativeEconomics.payoutFields, [0]);
  assert.equal(result.decision, "NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT");
  assert.deepEqual(result.pricePathDiagnostic.largestTickMove, {
    basisPoints: 100,
    fromEpoch: 100,
    fromQuote: 100,
    fromUtc: "1970-01-01T00:01:40.000Z",
    pointMove: 1,
    toEpoch: 101,
    toQuote: 101,
    toUtc: "1970-01-01T00:01:41.000Z",
  });
  assert.equal(result.stageDecisions[1].state,
    "NOT_RUN_STOP_CONDITION_INSUFFICIENT_EXECUTION_DATA");
  assert.equal(result.stageDecisions[2].state,
    "NOT_CREATED_NO_QUALIFIED_CANDIDATE");
  const markdown = renderRangeBreakObservationAssessmentMarkdown(result);
  assert.match(markdown, /zero\s+orders/i);
  assert.match(markdown, /SPECIFICATION_CONFLICT/);
  assert.match(markdown, /INSUFFICIENT_EXECUTION_DATA/);
  assert.match(markdown, /not a strategy\s+backtest/i);
});

test("matching advertised multiplier removes only the specification-conflict label", () => {
  const input = fixture({ advertised: [400] });
  const result = auditRangeBreakObservation({
    manifestBytes: input.manifestBytes,
    protocolBytes,
    rawBytes: input.rawBytes,
  });
  assert.deepEqual(result.classifications, ["INSUFFICIENT_EXECUTION_DATA"]);
  assert.equal(result.decision, "NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT");
});

test("tampered raw evidence fails checksum validation", () => {
  const input = fixture();
  assert.throws(() => auditRangeBreakObservation({
    manifestBytes: input.manifestBytes,
    protocolBytes,
    rawBytes: Buffer.concat([input.rawBytes, Buffer.from(" \n")]),
  }), /raw hash/);
});

test("incomplete observation cannot be promoted by a terminal manifest", () => {
  const input = fixture();
  const lines = input.rawBytes.toString("utf8").trim().split("\n");
  const end = JSON.parse(lines.at(-1));
  end.observedAtUtc = "2026-10-08T00:10:00.000Z";
  lines[lines.length - 1] = JSON.stringify(end);
  const rawBytes = Buffer.from(`${lines.join("\n")}\n`);
  const manifest = {
    ...input.manifest,
    rawSha256: hash(rawBytes),
  };
  assert.throws(() => auditRangeBreakObservation({
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    protocolBytes,
    rawBytes,
  }), /bounded completion rules/);
});

test("a self-consistent terminal summary cannot override independently counted ticks", () => {
  const input = fixture();
  const lines = input.rawBytes.toString("utf8").trim().split("\n");
  const end = JSON.parse(lines.at(-1));
  end.summary = { ...end.summary, ticks: 4 };
  lines[lines.length - 1] = JSON.stringify(end);
  const rawBytes = Buffer.from(`${lines.join("\n")}\n`);
  const manifest = {
    ...input.manifest,
    rawSha256: hash(rawBytes),
    summary: { ...input.manifest.summary, ticks: 4 },
  };
  assert.throws(() => auditRangeBreakObservation({
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    protocolBytes,
    rawBytes,
  }), /summary does not reproduce/);
});

test("order-bearing or authenticated records are rejected", () => {
  const input = fixture();
  const lines = input.rawBytes.toString("utf8").trim().split("\n");
  const capability = JSON.parse(lines[1]);
  capability.response.buy = "forbidden";
  lines[1] = JSON.stringify(capability);
  const rawBytes = Buffer.from(`${lines.join("\n")}\n`);
  const manifest = { ...input.manifest, rawSha256: hash(rawBytes) };
  assert.throws(() => auditRangeBreakObservation({
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    protocolBytes,
    rawBytes,
  }), /forbidden order field buy/);
});

test("the finite execution-economics calibration remains explicitly unauthorized", () => {
  assert.equal(calibrationDraft.status, "DRAFT_NOT_AUTHORIZED");
  assert.equal(calibrationDraft.ordersAuthorized, false);
  assert.equal(calibrationDraft.researchInferenceAllowed, false);
  assert.equal(calibrationDraft.maximumScopeIfSeparatelyAuthorized.contracts, 2);
  assert.equal(calibrationDraft.maximumScopeIfSeparatelyAuthorized.maximumOpenContracts, 1);
  assert.match(calibrationDraft.permittedConclusion,
    /EXECUTION_MODEL_FEASIBLE or INSUFFICIENT_EXECUTION_DATA/);
  assert.match(calibrationDraft.currentDecision, /DO_NOT_RUN/);
});

test("tracked completion package is hash-consistent and preserves the no-go scope", async () => {
  assert.equal(trackedInventory.decision, "NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT");
  for (const artifact of trackedInventory.artifacts.filter((item) =>
    item.availability === "PUBLIC_TRACKED")) {
    const bytes = await readFile(path.join(root, ...artifact.path.split("/")));
    assert.equal(bytes.length, artifact.bytes, artifact.id);
    assert.equal(hash(bytes), artifact.sha256, artifact.id);
  }
  const assessment = JSON.parse(await readFile(path.join(
    root,
    "research",
    "audits",
    "range-break-observer-v2-completion-2026-10-08.json",
  )));
  const manifest = JSON.parse(await readFile(path.join(
    root,
    "research",
    "evidence",
    "range-break-observation-v2-manifest-2026-10-08.json",
  )));
  assert.equal(assessment.artifacts.rawSha256, manifest.rawSha256);
  assert.equal(assessment.integrity.independentStrategyRegeneration, false);
  assert.equal(assessment.safety.ordersPlaced, 0);
  assert.equal(assessment.safety.strategySearchAuthorized, false);
  assert.equal(assessment.decision, "NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT");
});
