import { readFile } from "node:fs/promises";
import path from "node:path";

import { auditArchiveSlice } from "./archive-slice-audit.js";

const CHECKPOINT_STATES = new Set([
  "STARTING",
  "RUNNING",
  "BACKING_OFF",
  "PAUSED",
  "PARTIAL",
  "COMPLETED",
  "INCOMPLETE",
  "FAILED",
]);
const DEFAULT_APPROVED_SPEC =
  "research/protocols/historical-expansion-90day-v1.json";

function validateApprovedCollection(value) {
  const collection = {
    collectionId: value?.collectionId ?? null,
    fromEpoch: value?.fromEpoch ?? value?.fromEpochInclusive,
    sourceGapExceptions: value?.sourceGapExceptions ?? [],
    symbol: value?.symbol,
    toEpochExclusive: value?.toEpochExclusive,
  };
  if (typeof collection.symbol !== "string" ||
      !/^[A-Za-z0-9_]{2,30}$/.test(collection.symbol) ||
      !Number.isSafeInteger(collection.fromEpoch) ||
      !Number.isSafeInteger(collection.toEpochExclusive) ||
      collection.toEpochExclusive <= collection.fromEpoch ||
      !Array.isArray(collection.sourceGapExceptions)) {
    throw new Error("Approved historical collection specification is malformed.");
  }
  if (collection.sourceGapExceptions.length > 0) {
    throw new Error("Approved source-gap exceptions require a verifier not implemented here.");
  }
  return collection;
}

function validateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" ||
      !CHECKPOINT_STATES.has(checkpoint.state) ||
      typeof checkpoint.symbol !== "string" ||
      !/^[A-Za-z0-9_]{2,30}$/.test(checkpoint.symbol) ||
      !Number.isSafeInteger(checkpoint.fromEpoch) ||
      !Number.isSafeInteger(checkpoint.toEpochExclusive) ||
      checkpoint.toEpochExclusive <= checkpoint.fromEpoch ||
      !Number.isSafeInteger(checkpoint.pagesFetched) || checkpoint.pagesFetched < 0 ||
      !Number.isSafeInteger(checkpoint.rowsStored) || checkpoint.rowsStored < 0 ||
      !Number.isSafeInteger(checkpoint.cursorEpoch)) {
    throw new Error("Historical checkpoint is malformed.");
  }
  if (checkpoint.updatedAt !== undefined &&
      Number.isNaN(Date.parse(checkpoint.updatedAt))) {
    throw new Error("Historical checkpoint has an invalid update timestamp.");
  }
  return checkpoint;
}

function checkpointSnapshot(checkpoint) {
  return {
    archive: checkpoint.archive ?? null,
    cursorEpoch: checkpoint.cursorEpoch,
    fromEpoch: checkpoint.fromEpoch,
    lastError: checkpoint.lastError ?? null,
    pagesFetched: checkpoint.pagesFetched,
    pid: checkpoint.pid ?? null,
    rowsStored: checkpoint.rowsStored,
    state: checkpoint.state,
    symbol: checkpoint.symbol,
    toEpochExclusive: checkpoint.toEpochExclusive,
    updatedAt: checkpoint.updatedAt ?? null,
  };
}

function completionAuditMatches(checkpointAudit, actual) {
  return checkpointAudit &&
    checkpointAudit.availableRows === actual.observedGenuineSeconds &&
    checkpointAudit.expectedRows === actual.expectedSeconds &&
    checkpointAudit.missingRows === actual.missingSeconds;
}

function errorState(error, claimsCompletion) {
  if (error?.code === "ENOENT") return claimsCompletion ? "INCONSISTENT" : "UNAVAILABLE";
  if (/JSON|manifest|format|invalid/i.test(error.message)) {
    return claimsCompletion ? "INCONSISTENT" : "MALFORMED";
  }
  if (/checksum|duplicate|conflict|changed|bounds|row count|ordering/i.test(error.message)) {
    return "INTEGRITY_FAILURE";
  }
  return "UNVERIFIABLE";
}

function inspectManifestMetadata(manifest, checkpoint) {
  if (manifest?.version !== 1 || manifest.symbol !== checkpoint.symbol ||
      !Array.isArray(manifest.chunks)) {
    throw new Error("Historical archive manifest format or symbol is invalid.");
  }
  const selected = manifest.chunks
    .filter((chunk) => chunk.lastEpoch >= checkpoint.fromEpoch &&
      chunk.firstEpoch < checkpoint.toEpochExclusive)
    .map((chunk) => {
      if (typeof chunk.file !== "string" ||
          !Number.isSafeInteger(chunk.firstEpoch) ||
          !Number.isSafeInteger(chunk.lastEpoch) ||
          chunk.lastEpoch < chunk.firstEpoch ||
          !Number.isSafeInteger(chunk.rows) || chunk.rows < 1 ||
          !/^[a-f0-9]{64}$/.test(chunk.sha256 ?? "")) {
        throw new Error("Historical archive manifest contains invalid chunk metadata.");
      }
      return {
        firstEpoch: Math.max(chunk.firstEpoch, checkpoint.fromEpoch),
        lastEpoch: Math.min(chunk.lastEpoch, checkpoint.toEpochExclusive - 1),
      };
    })
    .sort((left, right) => left.firstEpoch - right.firstEpoch ||
      left.lastEpoch - right.lastEpoch);
  const intervals = [];
  for (const range of selected) {
    const previous = intervals.at(-1);
    if (!previous || range.firstEpoch > previous.lastEpoch + 1) {
      intervals.push({ ...range });
    } else {
      previous.lastEpoch = Math.max(previous.lastEpoch, range.lastEpoch);
    }
  }
  const missingRanges = [];
  let cursor = checkpoint.fromEpoch;
  for (const interval of intervals) {
    if (interval.firstEpoch > cursor) {
      missingRanges.push({
        fromEpoch: cursor,
        missingSeconds: interval.firstEpoch - cursor,
        toEpochExclusive: interval.firstEpoch,
      });
    }
    cursor = Math.max(cursor, interval.lastEpoch + 1);
  }
  if (cursor < checkpoint.toEpochExclusive) {
    missingRanges.push({
      fromEpoch: cursor,
      missingSeconds: checkpoint.toEpochExclusive - cursor,
      toEpochExclusive: checkpoint.toEpochExclusive,
    });
  }
  return {
    descriptorCoverageComplete: missingRanges.length === 0,
    manifestRangeGaps: missingRanges,
    selectedChunkDescriptors: selected.length,
    verificationDepth: "MANIFEST_METADATA_ONLY",
    warning: "Chunk files and row-level coverage were not checked because incomplete paging or descriptor coverage already disproves completion.",
  };
}

export async function assessHistoricalExpansion({
  approvedCollection = null,
  approvedSpecificationRelativePath = DEFAULT_APPROVED_SPEC,
  checkpointRelativePath = "data/market/historical-backfill-status.json",
  projectRoot,
  verifyArchiveContents = false,
}) {
  let approved;
  try {
    approved = validateApprovedCollection(approvedCollection ?? JSON.parse(await readFile(
      path.resolve(projectRoot, ...approvedSpecificationRelativePath.split("/")),
      "utf8",
    )));
  } catch (error) {
    return {
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      error: error.message,
      processObservation: { state: "NOT_CHECKED" },
      state: error?.code === "ENOENT" ? "UNAVAILABLE" : "MALFORMED",
      statusPath: checkpointRelativePath,
    };
  }
  const checkpointPath = path.resolve(
    projectRoot,
    ...checkpointRelativePath.split("/"),
  );
  let checkpoint;
  try {
    checkpoint = validateCheckpoint(JSON.parse(await readFile(checkpointPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
        approvedSpecificationPath: approvedSpecificationRelativePath,
        complete: false,
        processObservation: { state: "NOT_CHECKED" },
        state: "UNAVAILABLE",
        statusPath: checkpointRelativePath,
      };
    }
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      error: error.message,
      processObservation: { state: "NOT_CHECKED" },
      state: "MALFORMED",
      statusPath: checkpointRelativePath,
    };
  }

  if (checkpoint.symbol !== approved.symbol ||
      checkpoint.fromEpoch !== approved.fromEpoch ||
      checkpoint.toEpochExclusive !== approved.toEpochExclusive) {
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      error: "Checkpoint target conflicts with the approved collection specification.",
      processObservation: { state: "NOT_CHECKED" },
      requestedInterval: [checkpoint.fromEpoch, checkpoint.toEpochExclusive],
      snapshot: checkpointSnapshot(checkpoint),
      state: "INCONSISTENT",
      statusPath: checkpointRelativePath,
      symbol: checkpoint.symbol,
      verification: {
        approvedTargetMatchesCheckpoint: false,
        checkpointClaimsCompletion: checkpoint.state === "COMPLETED",
        manifestAndChunkIntegrity: "NOT_VERIFIED",
      },
    };
  }

  const snapshot = checkpointSnapshot(checkpoint);
  const claimsCompletion = checkpoint.state === "COMPLETED";
  let manifestMetadata;
  try {
    const manifestPath = path.join(
      projectRoot,
      "data",
      "market",
      checkpoint.symbol,
      "manifest.json",
    );
    manifestMetadata = inspectManifestMetadata(
      JSON.parse(await readFile(manifestPath, "utf8")),
      checkpoint,
    );
  } catch (error) {
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      error: error.message,
      processObservation: { state: "NOT_CHECKED" },
      requestedInterval: [checkpoint.fromEpoch, checkpoint.toEpochExclusive],
      snapshot,
      state: errorState(error, claimsCompletion),
      statusPath: checkpointRelativePath,
      symbol: checkpoint.symbol,
      verification: {
        approvedTargetMatchesCheckpoint: true,
        checkpointClaimsCompletion: claimsCompletion,
        manifestAndChunkIntegrity: "NOT_VERIFIED",
      },
    };
  }
  const reachedRequestedStart = checkpoint.cursorEpoch < checkpoint.fromEpoch;
  if (!verifyArchiveContents && !claimsCompletion &&
      (!reachedRequestedStart || !manifestMetadata.descriptorCoverageComplete)) {
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      collectionTerminalState: checkpoint.state,
      currentArchiveObservation: manifestMetadata,
      paging: {
        cursorEpoch: checkpoint.cursorEpoch,
        reachedRequestedStart,
      },
      processObservation: { state: "NOT_CHECKED" },
      requestedInterval: [checkpoint.fromEpoch, checkpoint.toEpochExclusive],
      snapshot,
      state: "INCOMPLETE",
      sourceGapEvidence: {
        independentlyVerifiedSourceGaps: [],
        unverifiedMissingRanges: manifestMetadata.manifestRangeGaps,
      },
      statusPath: checkpointRelativePath,
      symbol: checkpoint.symbol,
      verification: {
        approvedTargetMatchesCheckpoint: true,
        checkpointClaimsCompletion: false,
        exactCoverage: false,
        manifestAndChunkIntegrity: "NOT_FULLY_VERIFIED_NOT_NEEDED_TO_DISPROVE_COMPLETION",
      },
    };
  }
  try {
    const { audit } = await auditArchiveSlice({
      fromEpoch: checkpoint.fromEpoch,
      projectRoot,
      symbol: checkpoint.symbol,
      toEpochExclusive: checkpoint.toEpochExclusive,
    });
    const exactCoverage = audit.missingSeconds === 0 &&
      audit.observedGenuineSeconds === audit.expectedSeconds;
    const terminalEvidenceConsistent = claimsCompletion &&
      reachedRequestedStart &&
      completionAuditMatches(checkpoint.audit, audit);
    let state;
    if (claimsCompletion && exactCoverage && terminalEvidenceConsistent) {
      state = "VERIFIED_COMPLETE";
    } else if (claimsCompletion || exactCoverage) {
      state = "INCONSISTENT";
    } else {
      state = "INCOMPLETE";
    }
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: state === "VERIFIED_COMPLETE",
      collectionTerminalState: checkpoint.state,
      currentArchiveObservation: {
        checks: audit.checks,
        coverage: audit.coverage,
        expectedSeconds: audit.expectedSeconds,
        manifestSnapshotSha256: audit.manifestSnapshotSha256,
        missingRanges: audit.missingRanges,
        missingSeconds: audit.missingSeconds,
        observedGenuineSeconds: audit.observedGenuineSeconds,
        selectedChunks: audit.selectedChunks,
        sliceManifestSha256: audit.sliceManifestSha256,
      },
      paging: {
        cursorEpoch: checkpoint.cursorEpoch,
        reachedRequestedStart,
      },
      processObservation: { state: "NOT_CHECKED" },
      requestedInterval: [checkpoint.fromEpoch, checkpoint.toEpochExclusive],
      snapshot,
      state,
      sourceGapEvidence: {
        independentlyVerifiedSourceGaps: [],
        unverifiedMissingRanges: audit.missingRanges,
      },
      statusPath: checkpointRelativePath,
      symbol: checkpoint.symbol,
      verification: {
        approvedTargetMatchesCheckpoint: true,
        checkpointClaimsCompletion: claimsCompletion,
        checkpointCompletionAuditMatches: completionAuditMatches(checkpoint.audit, audit),
        exactCoverage,
        manifestAndChunkIntegrity: "VERIFIED",
      },
    };
  } catch (error) {
    return {
      approvedInterval: [approved.fromEpoch, approved.toEpochExclusive],
      approvedSpecificationPath: approvedSpecificationRelativePath,
      complete: false,
      error: error.message,
      processObservation: { state: "NOT_CHECKED" },
      requestedInterval: [checkpoint.fromEpoch, checkpoint.toEpochExclusive],
      snapshot,
      state: errorState(error, claimsCompletion),
      statusPath: checkpointRelativePath,
      symbol: checkpoint.symbol,
      verification: {
        approvedTargetMatchesCheckpoint: true,
        checkpointClaimsCompletion: claimsCompletion,
        manifestAndChunkIntegrity: "NOT_VERIFIED",
      },
    };
  }
}
