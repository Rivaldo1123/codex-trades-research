import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { auditArchiveSlice } from "./archive-slice-audit.js";
import { validateExperimentLedgerRecord } from "./experiment-ledger-audit.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function artifactPath(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 ||
      path.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be a non-empty repository-relative path.");
  }
  const absolute = path.resolve(projectRoot, ...relativePath.split("/"));
  const root = path.resolve(projectRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Artifact path escapes the project root.");
  }
  return absolute;
}

export function validateArtifactInventory(inventory) {
  if (inventory?.schemaVersion !== 1 ||
      inventory.kind !== "development-screen-v1-artifact-inventory" ||
      !Array.isArray(inventory.artifacts) ||
      inventory.artifacts.length === 0 ||
      typeof inventory.developmentScreen?.batchId !== "string" ||
      typeof inventory.developmentScreen?.reportedOutcome !== "string" ||
      !inventory.developmentScreen?.evaluatedSlice) {
    throw new Error("Artifact inventory has an unsupported structure.");
  }
  const ids = new Set();
  const paths = new Set();
  for (const artifact of inventory.artifacts) {
    if (typeof artifact?.id !== "string" || ids.has(artifact.id) ||
        typeof artifact.path !== "string" || paths.has(artifact.path) ||
        !SHA256_PATTERN.test(artifact.sha256 ?? "") ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 ||
        !Array.isArray(artifact.requiredFor) ||
        artifact.requiredFor.some((item) =>
          !["public-package", "development-reproduction"].includes(item))) {
      throw new Error("Artifact inventory contains an invalid or duplicate artifact.");
    }
    ids.add(artifact.id);
    paths.add(artifact.path);
  }
  const requiredIds = ["decision-matrix", "development-protocol", "development-summary", "development-ledger"];
  if (requiredIds.some((id) => !ids.has(id))) {
    throw new Error("Artifact inventory omits a required artifact identity.");
  }
  const slice = inventory.developmentScreen.evaluatedSlice;
  if (typeof slice.symbol !== "string" ||
      !Number.isSafeInteger(slice.fromEpoch) ||
      !Number.isSafeInteger(slice.toEpochExclusive) ||
      slice.toEpochExclusive <= slice.fromEpoch ||
      !SHA256_PATTERN.test(slice.contentSha256 ?? "") ||
      !SHA256_PATTERN.test(slice.sliceManifestSha256 ?? "") ||
      !Number.isSafeInteger(slice.expectedSeconds) ||
      !Number.isSafeInteger(slice.observedGenuineSeconds) ||
      !Number.isSafeInteger(slice.missingSeconds) ||
      !Number.isSafeInteger(slice.selectedChunks) ||
      slice.expectedSeconds !== slice.toEpochExclusive - slice.fromEpoch ||
      slice.observedGenuineSeconds + slice.missingSeconds !== slice.expectedSeconds ||
      !Array.isArray(slice.missingRanges)) {
    throw new Error("Artifact inventory contains an invalid evaluated slice.");
  }
  return inventory;
}

export async function verifyArtifact(projectRoot, artifact) {
  let absolute;
  try {
    absolute = artifactPath(projectRoot, artifact.path);
  } catch (error) {
    return {
      id: artifact.id,
      path: artifact.path,
      state: "MALFORMED",
      error: error.message,
    };
  }
  try {
    const fileStat = await stat(absolute);
    if (!fileStat.isFile()) {
      return {
        id: artifact.id,
        path: artifact.path,
        state: "UNVERIFIABLE",
        error: "Artifact path is not a regular file.",
      };
    }
    const actualSha256 = await hashFile(absolute);
    const sizeMatches = fileStat.size === artifact.bytes;
    const hashMatches = actualSha256 === artifact.sha256;
    let formatState = "NOT_APPLICABLE";
    let formatError;
    if (artifact.format === "json") {
      try {
        JSON.parse(await readFile(absolute, "utf8"));
        formatState = "VALID";
      } catch (error) {
        formatState = "MALFORMED";
        formatError = error.message;
      }
    }
    let state = "VERIFIED";
    if (!hashMatches || !sizeMatches) state = "HASH_MISMATCH";
    else if (formatState === "MALFORMED") state = "MALFORMED";
    return {
      actualBytes: fileStat.size,
      actualSha256,
      expectedBytes: artifact.bytes,
      expectedSha256: artifact.sha256,
      formatState,
      ...(formatError ? { formatError } : {}),
      id: artifact.id,
      path: artifact.path,
      requiredFor: artifact.requiredFor,
      state,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        expectedBytes: artifact.bytes,
        expectedSha256: artifact.sha256,
        id: artifact.id,
        path: artifact.path,
        requiredFor: artifact.requiredFor,
        state: "MISSING",
      };
    }
    return {
      error: error.message,
      expectedBytes: artifact.bytes,
      expectedSha256: artifact.sha256,
      id: artifact.id,
      path: artifact.path,
      requiredFor: artifact.requiredFor,
      state: "UNVERIFIABLE",
    };
  }
}

export async function readVerifiedJson(projectRoot, artifact, verification) {
  if (verification.state !== "VERIFIED") return null;
  return JSON.parse(await readFile(artifactPath(projectRoot, artifact.path), "utf8"));
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

export function validatePublishedDevelopmentArtifacts({ protocol, protocolSha256, summary }) {
  if (protocol?.schemaVersion !== 1 || typeof protocol.batchId !== "string" ||
      !Array.isArray(protocol.evaluationWindows) || protocol.evaluationWindows.length === 0 ||
      !Array.isArray(protocol.parameterRanges?.entryDelayTicks) ||
      !Array.isArray(protocol.parameterRanges?.profitPerDollarOnWin) ||
      !Number.isSafeInteger(protocol.searchBudget?.plannedUniqueConfigurations)) {
    throw new Error("Frozen development protocol is malformed.");
  }
  for (const window of protocol.evaluationWindows) {
    if (typeof window.id !== "string" ||
        !Number.isSafeInteger(window.fromEpochInclusive) ||
        !Number.isSafeInteger(window.toEpochExclusive) ||
        window.toEpochExclusive <= window.fromEpochInclusive) {
      throw new Error("Frozen protocol contains an invalid evaluation window.");
    }
  }
  const familyBudget = Object.values(protocol.searchBudget.families ?? {});
  if (familyBudget.length === 0 || familyBudget.some((value) =>
    !Number.isSafeInteger(value) || value < 1) ||
    familyBudget.reduce((sum, value) => sum + value, 0) !==
      protocol.searchBudget.plannedUniqueConfigurations) {
    throw new Error("Frozen protocol search budget is inconsistent.");
  }
  if (summary?.kind !== "strategy-development-search-summary" ||
      summary.batchId !== protocol.batchId ||
      typeof summary.outcome !== "string" ||
      summary.protocol?.sha256 !== protocolSha256 ||
      summary.protocol?.path !== "research/protocols/development-screen-v1.json" ||
      typeof summary.detailedLedger?.finalPath !== "string" ||
      !SHA256_PATTERN.test(summary.detailedLedger?.finalSha256 ?? "")) {
    throw new Error("Published development summary identity is malformed or inconsistent.");
  }
  const countNames = [
    "strategyFamilies",
    "uniqueConfigurationsPlanned",
    "uniqueConfigurationsCompleted",
    "evaluationWindows",
    "stressScenariosPerWindow",
    "totalBacktestRunsCompleted",
    "invalidGridCombinations",
    "duplicateConfigurations",
    "failedTrials",
    "developmentQualified",
    "frozenFinalists",
  ];
  for (const name of countNames) requireNonNegativeInteger(summary.counts?.[name], `summary.counts.${name}`);
  const expectedScenarioRuns = summary.counts.uniqueConfigurationsCompleted *
    protocol.evaluationWindows.length *
    protocol.parameterRanges.entryDelayTicks.length *
    protocol.parameterRanges.profitPerDollarOnWin.length;
  const expectedScenariosPerWindow = protocol.parameterRanges.entryDelayTicks.length *
    protocol.parameterRanges.profitPerDollarOnWin.length;
  if (summary.counts.uniqueConfigurationsPlanned !==
        protocol.searchBudget.plannedUniqueConfigurations ||
      summary.counts.evaluationWindows !== protocol.evaluationWindows.length ||
      summary.counts.stressScenariosPerWindow !== expectedScenariosPerWindow ||
      summary.counts.totalBacktestRunsCompleted !== expectedScenarioRuns ||
      summary.dataset?.symbol !== protocol.dataset?.symbol ||
      summary.dataset?.fromEpoch !== protocol.dataset?.fromEpochInclusive ||
      summary.dataset?.toEpochExclusive !== protocol.dataset?.toEpochExclusive) {
    throw new Error("Published development summary metrics conflict with the frozen protocol.");
  }
  return {
    batchId: summary.batchId,
    counts: structuredClone(summary.counts),
    dataset: structuredClone(summary.dataset),
    ledger: structuredClone(summary.detailedLedger),
    outcome: summary.outcome,
    protocolSha256,
  };
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function sameObject(left, right) {
  const normalize = (value) => Object.fromEntries(
    Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export async function recomputeLedgerSummary({
  ledgerPath,
  protocol,
  protocolSha256,
  summary,
}) {
  const configurationHashes = new Set();
  const trialIds = new Set();
  const families = new Map();
  const rejectionReasonCounts = {};
  const provenance = {
    codeCommits: new Set(),
    datasetManifestSha256: new Set(),
    protocolSha256: new Set(),
  };
  let accountingChecksPassed = 0;
  let developmentQualified = 0;
  let row = 0;
  try {
    const input = createReadStream(ledgerPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      row += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Ledger row ${row} is not valid JSON: ${error.message}`);
      }
      if (configurationHashes.has(record.configurationHash) || trialIds.has(record.trialId)) {
        throw new Error(`Ledger row ${row} duplicates a configuration or trial identity.`);
      }
      configurationHashes.add(record.configurationHash);
      trialIds.add(record.trialId);
      validateExperimentLedgerRecord(record, protocol);
      accountingChecksPassed += 1;
      families.set(record.family, (families.get(record.family) ?? 0) + 1);
      if (record.evaluation.qualifiesDevelopment === true) developmentQualified += 1;
      for (const reason of record.evaluation.acceptanceFailures ?? []) {
        increment(rejectionReasonCounts, reason);
      }
      provenance.codeCommits.add(record.codeCommit);
      provenance.datasetManifestSha256.add(record.dataset?.manifestSha256);
      provenance.protocolSha256.add(record.protocolSha256);
      if (record.dataset?.symbol !== summary.dataset.symbol ||
          record.dataset?.fromEpochInclusive !== summary.dataset.fromEpoch ||
          record.dataset?.toEpochExclusive !== summary.dataset.toEpochExclusive) {
        throw new Error(`Ledger row ${row} has inconsistent dataset provenance.`);
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "MISSING", error: "Development ledger is unavailable." };
    }
    return {
      state: /not valid JSON/.test(error.message) ? "MALFORMED" : "INTEGRITY_FAILURE",
      error: error.message,
      row,
    };
  }

  const computed = {
    accountingChecksPassed,
    configurationHashesUnique: configurationHashes.size,
    developmentQualified,
    familyConfigurationCounts: Object.fromEntries(
      [...families.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    rejectionReasonCounts: Object.fromEntries(
      Object.entries(rejectionReasonCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    trialIdsUnique: trialIds.size,
  };
  const singleton = (set) => set.size === 1 ? [...set][0] : null;
  const provenanceResult = {
    codeCommit: singleton(provenance.codeCommits),
    datasetManifestSha256: singleton(provenance.datasetManifestSha256),
    protocolSha256: singleton(provenance.protocolSha256),
  };
  const failures = [];
  if (accountingChecksPassed !== summary.counts.uniqueConfigurationsCompleted) {
    failures.push("ledger record count differs from the published completed count");
  }
  if (configurationHashes.size !== accountingChecksPassed || trialIds.size !== accountingChecksPassed) {
    failures.push("ledger identities are not unique");
  }
  if (families.size !== summary.counts.strategyFamilies) {
    failures.push("ledger family count differs from the published family count");
  }
  if (developmentQualified !== summary.counts.developmentQualified) {
    failures.push("ledger qualified count differs from the published qualified count");
  }
  if (!sameObject(rejectionReasonCounts, summary.rejectionReasonCounts)) {
    failures.push("ledger rejection counts differ from the published summary");
  }
  if (provenanceResult.protocolSha256 !== protocolSha256 ||
      provenanceResult.datasetManifestSha256 !== summary.dataset.manifestSha256 ||
      provenanceResult.codeCommit !== summary.code?.commit) {
    failures.push("ledger provenance differs from the published protocol, dataset, or code commit");
  }
  return {
    calculationsRecomputed: [
      "every scenario payout/accounting field",
      "record/configuration/trial cardinality",
      "family configuration counts",
      "development-qualified count",
      "rejection-reason counts",
      "ledger provenance singletons",
    ],
    computed,
    failures,
    provenance: provenanceResult,
    state: failures.length === 0 ? "RECOMPUTED_AND_MATCHED" : "INTEGRITY_FAILURE",
    strategySignalsRerun: false,
  };
}

export async function verifyEvaluatedArchiveSlice(projectRoot, expected) {
  try {
    const result = await auditArchiveSlice({
      fromEpoch: expected.fromEpoch,
      projectRoot,
      symbol: expected.symbol,
      toEpochExclusive: expected.toEpochExclusive,
    });
    const actual = result.audit;
    const normalizedRanges = (ranges) => ranges.map((range) => ({
      fromEpoch: range.fromEpoch,
      missingSeconds: range.missingSeconds,
      toEpochExclusive: range.toEpochExclusive,
    }));
    const matches = actual.contentSha256 === expected.contentSha256 &&
      actual.sliceManifestSha256 === expected.sliceManifestSha256 &&
      actual.expectedSeconds === expected.expectedSeconds &&
      actual.observedGenuineSeconds === expected.observedGenuineSeconds &&
      actual.missingSeconds === expected.missingSeconds &&
      actual.selectedChunks === expected.selectedChunks &&
      JSON.stringify(normalizedRanges(actual.missingRanges)) ===
        JSON.stringify(normalizedRanges(expected.missingRanges));
    return {
      actual,
      expected: structuredClone(expected),
      state: matches ? "VERIFIED" : "HASH_MISMATCH",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        error: error.message,
        expected: structuredClone(expected),
        state: "MISSING",
      };
    }
    return {
      error: error.message,
      expected: structuredClone(expected),
      state: /checksum|duplicate|conflict|changed|bounds|row/i.test(error.message)
        ? "INTEGRITY_FAILURE"
        : "UNVERIFIABLE",
    };
  }
}

export function resolveArtifactPath(projectRoot, relativePath) {
  return artifactPath(projectRoot, relativePath);
}
