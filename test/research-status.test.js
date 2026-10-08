import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditArchiveSlice } from "../src/archive-slice-audit.js";
import { appendTickChunk } from "../src/data-store.js";
import { referenceScore } from "../src/experiment-ledger-audit.js";
import { buildResearchStatus, strictExitCode } from "../src/research-status.js";
import { canonicalJson, sha256 } from "../src/strategy-search-config.js";

const PUBLIC_MATRIX_PATH = "research/feasibility/evidence-blocker-matrix-v2-2026-10-08.json";
const PROTOCOL_PATH = "research/protocols/development-screen-v1.json";
const SUMMARY_PATH = "research/results/development-screen-v1-summary.json";
const LEDGER_PATH = "data/research/development-screen-v1/ledger.final.jsonl";
const INVENTORY_PATH = "research/reproducibility/development-screen-v1-artifact-inventory.json";
const CHECKPOINT_PATH = "data/market/historical-backfill-status.json";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(id, artifactPath, format, content, requiredFor) {
  const bytes = Buffer.from(content);
  return {
    id,
    path: artifactPath,
    format,
    bytes: bytes.length,
    sha256: digest(bytes),
    availability: requiredFor.includes("public-package")
      ? "PUBLIC_TRACKED"
      : "LOCAL_IGNORED_AVAILABLE_AT_INVENTORY",
    requiredFor,
  };
}

function buildProtocol() {
  return {
    schemaVersion: 1,
    batchId: "development-screen-v1",
    dataset: {
      symbol: "1HZ100V",
      fromEpochInclusive: 100,
      toEpochExclusive: 103,
    },
    searchBudget: {
      families: { unconditional_baseline: 1 },
      plannedUniqueConfigurations: 1,
    },
    parameterRanges: {
      entryDelayTicks: [1],
      profitPerDollarOnWin: [0.7, 0.8, 0.9],
    },
    evaluationWindows: [{
      id: "development",
      fromEpochInclusive: 100,
      toEpochExclusive: 103,
    }],
    acceptanceRules: {
      basePayoutOnWin: 0.9,
      stressPayoutOnWin: 0.8,
      reportedSevereStressPayoutOnWin: 0.7,
    },
  };
}

function buildLedgerRecord(protocol, protocolSha256, datasetManifestSha256) {
  const configuration = {
    direction: "rise",
    durationTicks: 1,
    family: "unconditional_baseline",
  };
  const counts = { losses: 2, ties: 0, trades: 3, wins: 1 };
  const payoutScores = Object.fromEntries(protocol.parameterRanges.profitPerDollarOnWin
    .map((payout) => [String(payout), referenceScore(counts, payout)]));
  return {
    trialId: "development-screen-v1:test",
    strategyId: "unconditional_baseline:test",
    family: configuration.family,
    configurationHash: sha256(canonicalJson(configuration)),
    configuration,
    codeCommit: "b".repeat(40),
    trackedWorktreeDirty: false,
    protocolSha256,
    dataset: {
      fromEpochInclusive: 100,
      manifestSha256: datasetManifestSha256,
      previouslyViewed: true,
      source: "fixture",
      symbol: "1HZ100V",
      toEpochExclusive: 103,
    },
    evaluation: {
      activity: { activeCalendarDays: 1, decisionsSampled: 1, maximumLookbackTicks: 1 },
      base: referenceScore(counts, 0.9),
      minimumSevereStressAverageProfitPerDollarStaked:
        payoutScores["0.7"].averageProfitPerDollarStaked,
      minimumStressAverageProfitPerDollarStaked:
        payoutScores["0.8"].averageProfitPerDollarStaked,
      scenarios: [{ counts, delayTicks: 1, payoutScores, windowId: "development" }],
      acceptanceFailures: ["base_expectancy_below_minimum"],
      qualifiesDevelopment: false,
    },
    failed: false,
    failureReason: null,
    finalAssessment: true,
  };
}

async function createFixture({ checkpoint = "complete", malformedSummary = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-status-"));
  const protocol = buildProtocol();
  const protocolContent = json(protocol);
  const protocolSha256 = digest(protocolContent);
  const datasetManifestSha256 = "a".repeat(64);
  const record = buildLedgerRecord(protocol, protocolSha256, datasetManifestSha256);
  const ledgerContent = `${JSON.stringify(record)}\n`;
  const summary = {
    kind: "strategy-development-search-summary",
    outcome: "NO_RELIABLE_EDGE_FOUND",
    batchId: protocol.batchId,
    code: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    protocol: { path: PROTOCOL_PATH, sha256: protocolSha256 },
    dataset: {
      symbol: "1HZ100V",
      fromEpoch: 100,
      toEpochExclusive: 103,
      expectedSeconds: 3,
      observedGenuineSeconds: 3,
      missingSeconds: 0,
      missingRanges: [],
      selectedChunks: 1,
      manifestSha256: datasetManifestSha256,
    },
    counts: {
      strategyFamilies: 1,
      uniqueConfigurationsPlanned: 1,
      uniqueConfigurationsCompleted: 1,
      evaluationWindows: 1,
      stressScenariosPerWindow: 3,
      totalBacktestRunsCompleted: 3,
      invalidGridCombinations: 0,
      duplicateConfigurations: 0,
      failedTrials: 0,
      developmentQualified: 0,
      frozenFinalists: 0,
    },
    rejectionReasonCounts: { base_expectancy_below_minimum: 1 },
    detailedLedger: {
      finalPath: LEDGER_PATH,
      retainedLocallyOutsideGit: true,
      finalSha256: digest(ledgerContent),
    },
  };
  const summaryContent = malformedSummary ? "{ definitely-not-json\n" : json(summary);
  const matrix = {
    schemaVersion: 2,
    kind: "feasibility-evidence-and-blocker-matrix",
    priorSearch: {
      hypothesisScope: "Fixture short-tick scope.",
      preciseConclusion: "Reported fixture conclusion.",
    },
    directions: [],
    holdout: { status: "NOT_ASSIGNED" },
    decision: {
      code: "NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS",
      validatedEdge: false,
      implementationReadiness: "NOT_READY_NO_VALIDATED_EDGE",
    },
  };
  const matrixContent = json(matrix);
  await write(root, PUBLIC_MATRIX_PATH, matrixContent);
  await write(root, PROTOCOL_PATH, protocolContent);
  await write(root, SUMMARY_PATH, summaryContent);
  await write(root, LEDGER_PATH, ledgerContent);
  await appendTickChunk(root, "1HZ100V", [
    { epoch: 100, quote: 100 },
    { epoch: 101, quote: 101 },
    { epoch: 102, quote: 100.5 },
  ], { retrievedAt: "2026-10-08T00:00:00Z", source: "fixture" });
  const slice = (await auditArchiveSlice({
    fromEpoch: 100,
    projectRoot: root,
    symbol: "1HZ100V",
    toEpochExclusive: 103,
  })).audit;
  const artifacts = [
    artifact("decision-matrix", PUBLIC_MATRIX_PATH, "json", matrixContent, ["public-package"]),
    artifact("development-protocol", PROTOCOL_PATH, "json", protocolContent,
      ["public-package", "development-reproduction"]),
    artifact("development-summary", SUMMARY_PATH, "json", summaryContent,
      ["public-package", "development-reproduction"]),
    artifact("development-ledger", LEDGER_PATH, "jsonl", ledgerContent,
      ["development-reproduction"]),
  ];
  const inventory = {
    schemaVersion: 1,
    kind: "development-screen-v1-artifact-inventory",
    artifacts,
    developmentScreen: {
      batchId: "development-screen-v1",
      reportedOutcome: "NO_RELIABLE_EDGE_FOUND",
      evaluatedSlice: {
        symbol: "1HZ100V",
        fromEpoch: 100,
        toEpochExclusive: 103,
        expectedSeconds: 3,
        observedGenuineSeconds: 3,
        missingSeconds: 0,
        missingRanges: [],
        selectedChunks: 1,
        contentSha256: slice.contentSha256,
        sliceManifestSha256: slice.sliceManifestSha256,
      },
    },
  };
  await write(root, INVENTORY_PATH, json(inventory));

  let checkpointContent;
  if (checkpoint === "malformed") {
    checkpointContent = "{ not-json\n";
  } else if (checkpoint === "partial") {
    checkpointContent = json({
      state: "FAILED",
      pid: 99,
      symbol: "1HZ100V",
      fromEpoch: 90,
      toEpochExclusive: 103,
      pagesFetched: 1,
      rowsStored: 3,
      cursorEpoch: 99,
      updatedAt: "2026-10-08T00:00:00Z",
    });
  } else if (checkpoint === "false-complete") {
    checkpointContent = json({
      state: "COMPLETED",
      pid: 99,
      symbol: "1HZ100V",
      fromEpoch: 100,
      toEpochExclusive: 104,
      pagesFetched: 1,
      rowsStored: 3,
      cursorEpoch: 99,
      audit: { availableRows: 4, expectedRows: 4, missingRows: 0 },
      updatedAt: "2026-10-08T00:00:00Z",
    });
  } else {
    checkpointContent = json({
      state: "COMPLETED",
      pid: 99,
      symbol: "1HZ100V",
      fromEpoch: 100,
      toEpochExclusive: 103,
      pagesFetched: 1,
      rowsStored: 3,
      cursorEpoch: 99,
      audit: { availableRows: 3, expectedRows: 3, missingRows: 0 },
      updatedAt: "2026-10-08T00:00:00Z",
    });
  }
  await write(root, CHECKPOINT_PATH, checkpointContent);
  return { root };
}

async function withFixture(options, callback) {
  const fixture = await createFixture(options);
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
}

test("valid evidence recomputes ledger summaries and verifies complete archive coverage", async () => {
  await withFixture({}, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root, recomputeDevelopment: true });
    assert.equal(status.evidenceHealth.publicPackage.state, "VERIFIED");
    assert.equal(status.evidenceHealth.developmentReproduction.state,
      "VERIFIED_PARTIAL_REPRODUCTION");
    assert.equal(status.dataCompleteness.developmentScreen.status,
      "REPORTED_COMPLETE_LEDGER_SUMMARY_RECOMPUTED");
    assert.equal(status.dataCompleteness.developmentScreen
      .independentReproducibility.ledgerSummary.state, "RECOMPUTED_AND_MATCHED");
    assert.equal(status.dataCompleteness.developmentScreen
      .independentReproducibility.originalStrategySimulationRerun, false);
    assert.equal(status.dataCompleteness.historicalExpansion90Day.state, "VERIFIED_COMPLETE");
    assert.equal(status.dataCompleteness.historicalExpansion90Day.complete, true);
    assert.equal(strictExitCode(status, "public"), 0);
    assert.equal(strictExitCode(status, "reproduction"), 0);
  });
});

test("matching hashes in normal mode do not claim calculations were reproduced", async () => {
  await withFixture({}, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root });
    assert.equal(status.dataCompleteness.developmentScreen.evidenceState, "VERIFIED");
    assert.equal(status.dataCompleteness.developmentScreen.status,
      "REPORTED_COMPLETE_NOT_INDEPENDENTLY_REPRODUCED");
    assert.equal(status.dataCompleteness.developmentScreen
      .independentReproducibility.ledgerSummary.state, "NOT_RUN");
    assert.equal(status.evidenceHealth.overallState,
      "PUBLIC_PACKAGE_VERIFIED_REPRODUCTION_LIMITED");
    assert.equal(status.evidenceHealth.developmentReproduction.state, "NOT_RUN");
  });
});

test("missing ledger preserves the published finding but blocks local reproduction", async () => {
  await withFixture({}, async ({ root }) => {
    await unlink(path.join(root, ...LEDGER_PATH.split("/")));
    const status = await buildResearchStatus({ projectRoot: root, recomputeDevelopment: true });
    assert.equal(status.publishedResearch.developmentScreen.outcome, "NO_RELIABLE_EDGE_FOUND");
    assert.equal(status.publishedResearch.developmentScreen.reportedCompletion, true);
    assert.equal(status.dataCompleteness.developmentScreen.evidenceState, "MISSING");
    assert.equal(status.dataCompleteness.developmentScreen.status,
      "REPORTED_COMPLETE_LEDGER_MISSING");
    assert.equal(status.dataCompleteness.developmentScreen
      .independentReproducibility.level, "NOT_REPRODUCED");
    assert.equal(strictExitCode(status, "public"), 0);
    assert.equal(strictExitCode(status, "reproduction"), 2);
  });
});

test("altered ledger produces a prominent integrity failure", async () => {
  await withFixture({}, async ({ root }) => {
    await appendFile(path.join(root, ...LEDGER_PATH.split("/")), "altered\n");
    const status = await buildResearchStatus({ projectRoot: root, recomputeDevelopment: true });
    assert.equal(status.dataCompleteness.developmentScreen.evidenceState, "HASH_MISMATCH");
    assert.equal(status.dataCompleteness.developmentScreen.status,
      "REPORTED_COMPLETE_INTEGRITY_FAILURE");
    assert.equal(status.evidenceHealth.hasIntegrityFailure, true);
    assert.equal(status.evidenceHealth.overallState, "INTEGRITY_FAILURE");
    assert.ok(status.evidenceHealth.integrityFailures.some((failure) =>
      failure.id === "development-ledger" && failure.path === LEDGER_PATH &&
      failure.state === "HASH_MISMATCH"));
    assert.ok(status.evidenceHealth.integrityFailures.some((failure) =>
      failure.id === "ledger-summary-recomputation" &&
      failure.state === "INTEGRITY_FAILURE"));
    assert.deepEqual(status.evidenceHealth.integrityFailures[0], {
      id: "development-ledger",
      path: LEDGER_PATH,
      state: "HASH_MISMATCH",
    });
    assert.equal(strictExitCode(status, "reproduction"), 3);
  });
});

test("altered required public evidence fails public strict verification", async () => {
  await withFixture({}, async ({ root }) => {
    await appendFile(path.join(root, ...SUMMARY_PATH.split("/")), " \n");
    const status = await buildResearchStatus({ projectRoot: root });
    const summary = status.evidenceVerification.find((item) =>
      item.id === "development-summary");
    assert.equal(summary.state, "HASH_MISMATCH");
    assert.equal(status.evidenceHealth.publicPackage.state, "INTEGRITY_FAILURE");
    assert.equal(strictExitCode(status, "public"), 3);
  });
});

test("malformed evidence and malformed checkpoints are explicit", async () => {
  await withFixture({ checkpoint: "malformed", malformedSummary: true }, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root, recomputeDevelopment: true });
    const summary = status.evidenceVerification.find((item) =>
      item.id === "development-summary");
    assert.equal(summary.state, "MALFORMED");
    assert.equal(status.publishedResearch.developmentScreen.status,
      "REPORTED_FINDING_SOURCE_UNVERIFIABLE");
    assert.equal(status.dataCompleteness.historicalExpansion90Day.state, "MALFORMED");
    assert.equal(strictExitCode(status, "public"), 2);
  });
});

test("partial historical collection is incomplete without claiming process state", async () => {
  await withFixture({ checkpoint: "partial" }, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root });
    const historical = status.dataCompleteness.historicalExpansion90Day;
    assert.equal(historical.state, "INCOMPLETE");
    assert.equal(historical.complete, false);
    assert.equal(historical.paging.reachedRequestedStart, false);
    assert.equal(historical.processObservation.state, "NOT_CHECKED");
    assert.ok(historical.currentArchiveObservation.manifestRangeGaps.length > 0);
  });
});

test("a COMPLETED checkpoint cannot override incomplete row coverage", async () => {
  await withFixture({ checkpoint: "false-complete" }, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root });
    const historical = status.dataCompleteness.historicalExpansion90Day;
    assert.equal(historical.state, "INCONSISTENT");
    assert.equal(historical.complete, false);
    assert.equal(historical.verification.checkpointClaimsCompletion, true);
    assert.equal(historical.verification.exactCoverage, false);
    assert.equal(historical.currentArchiveObservation.missingSeconds, 1);
  });
});

test("status safety can never authorize execution", async () => {
  await withFixture({}, async ({ root }) => {
    const status = await buildResearchStatus({ projectRoot: root });
    assert.equal(status.validatedEdge, false);
    assert.equal(status.implementationReadiness, "NOT_READY_NO_VALIDATED_EDGE");
    assert.deepEqual(status.safety, {
      authenticates: false,
      executionAuthorized: false,
      startsCollectors: false,
      startsSearches: false,
      placesOrders: false,
      usesNetwork: false,
    });
    assert.throws(() => strictExitCode(status, "trading"), /Unsupported strict mode/);
  });
});
