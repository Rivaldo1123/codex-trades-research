import { readFile } from "node:fs/promises";
import path from "node:path";

import { assessHistoricalExpansion } from "./historical-archive-status.js";
import {
  readVerifiedJson,
  recomputeLedgerSummary,
  resolveArtifactPath,
  validateArtifactInventory,
  validatePublishedDevelopmentArtifacts,
  verifyArtifact,
  verifyEvaluatedArchiveSlice,
} from "./research-reproduction.js";

export const DEFAULT_ARTIFACT_INVENTORY =
  "research/reproducibility/development-screen-v1-artifact-inventory.json";

const STRICT_MODES = new Set(["public", "reproduction"]);

function uniqueBlockers(directions) {
  return [...new Set((directions ?? [])
    .flatMap((direction) => direction.blockers ?? []))].sort();
}

function artifactById(inventory, id) {
  return inventory.artifacts.find((artifact) => artifact.id === id);
}

function verificationById(verifications, id) {
  return verifications.find((item) => item.id === id);
}

function replaceVerification(verifications, id, replacement) {
  const index = verifications.findIndex((item) => item.id === id);
  if (index >= 0) verifications[index] = { ...verifications[index], ...replacement };
}

function matrixIsUsable(matrix) {
  return matrix?.schemaVersion === 2 &&
    matrix.kind === "feasibility-evidence-and-blocker-matrix" &&
    typeof matrix.decision?.code === "string" &&
    matrix.decision.validatedEdge === false &&
    matrix.decision.implementationReadiness === "NOT_READY_NO_VALIDATED_EDGE" &&
    Array.isArray(matrix.directions) &&
    matrix.directions.every((direction) =>
      typeof direction.id === "string" && Array.isArray(direction.classifications));
}

function requirementFailureState(failures) {
  if (failures.some((failure) =>
    ["HASH_MISMATCH", "INTEGRITY_FAILURE"].includes(failure.state))) {
    return { exitCode: 3, state: "INTEGRITY_FAILURE" };
  }
  return { exitCode: 2, state: "REQUIRED_EVIDENCE_UNAVAILABLE" };
}

function publicRequirement(inventory, verifications) {
  const required = inventory.artifacts
    .filter((artifact) => artifact.requiredFor.includes("public-package"));
  const failures = required
    .map((artifact) => verificationById(verifications, artifact.id))
    .filter((verification) => verification?.state !== "VERIFIED")
    .map((verification) => ({
      id: verification?.id ?? "UNKNOWN",
      path: verification?.path ?? null,
      state: verification?.state ?? "UNVERIFIABLE",
    }));
  if (failures.length === 0) {
    return {
      exitCode: 0,
      failures,
      requiredArtifactIds: required.map((artifact) => artifact.id),
      state: "VERIFIED",
    };
  }
  return {
    ...requirementFailureState(failures),
    failures,
    requiredArtifactIds: required.map((artifact) => artifact.id),
  };
}

function reproductionRequirement(inventory, verifications, ledgerRecomputation, slice) {
  const required = inventory.artifacts
    .filter((artifact) => artifact.requiredFor.includes("public-package") ||
      artifact.requiredFor.includes("development-reproduction"));
  const failures = required
    .map((artifact) => verificationById(verifications, artifact.id))
    .filter((verification) => verification?.state !== "VERIFIED")
    .map((verification) => ({
      id: verification?.id ?? "UNKNOWN",
      path: verification?.path ?? null,
      state: verification?.state ?? "UNVERIFIABLE",
    }));
  if (ledgerRecomputation.state !== "RECOMPUTED_AND_MATCHED") {
    failures.push({ id: "ledger-summary-recomputation", state: ledgerRecomputation.state });
  }
  if (slice.state !== "VERIFIED") {
    failures.push({ id: "evaluated-market-slice", state: slice.state });
  }
  if (failures.length > 0 && failures.every((failure) =>
    ["NOT_RUN", "NOT_CHECKED"].includes(failure.state))) {
    return {
      exitCode: 2,
      failures,
      requiredArtifactIds: [
        ...required.map((artifact) => artifact.id),
        "evaluated-market-slice",
      ],
      state: "NOT_RUN",
    };
  }
  if (failures.length === 0) {
    return {
      exitCode: 0,
      failures,
      requiredArtifactIds: [
        ...required.map((artifact) => artifact.id),
        "evaluated-market-slice",
      ],
      state: "VERIFIED_PARTIAL_REPRODUCTION",
    };
  }
  return {
    ...requirementFailureState(failures),
    failures,
    requiredArtifactIds: [
      ...required.map((artifact) => artifact.id),
      "evaluated-market-slice",
    ],
  };
}

function overallEvidenceState({ publicPackage, reproduction, verifications, ledger, slice }) {
  const integrityFailure = verifications.some((item) => item.state === "HASH_MISMATCH") ||
    ledger.state === "INTEGRITY_FAILURE" ||
    ["HASH_MISMATCH", "INTEGRITY_FAILURE"].includes(slice.state);
  if (integrityFailure) return "INTEGRITY_FAILURE";
  if (publicPackage.state !== "VERIFIED") return "PUBLIC_PACKAGE_UNVERIFIABLE";
  if (reproduction.state === "VERIFIED_PARTIAL_REPRODUCTION") {
    return "PUBLIC_PACKAGE_AND_LOCAL_REPRODUCTION_EVIDENCE_VERIFIED";
  }
  return "PUBLIC_PACKAGE_VERIFIED_REPRODUCTION_LIMITED";
}

function developmentStatus({ published, ledgerVerification, ledgerRecomputation }) {
  if (published.sourceState !== "VERIFIED") {
    return "REPORTED_FINDING_SOURCE_UNVERIFIABLE";
  }
  if (ledgerVerification?.state === "MISSING") return "REPORTED_COMPLETE_LEDGER_MISSING";
  if (ledgerVerification?.state === "MALFORMED") {
    return "REPORTED_COMPLETE_LEDGER_MALFORMED";
  }
  if (ledgerVerification?.state === "UNVERIFIABLE") {
    return "REPORTED_COMPLETE_LEDGER_UNVERIFIABLE";
  }
  if (ledgerVerification?.state === "HASH_MISMATCH" ||
      ledgerRecomputation.state === "INTEGRITY_FAILURE") {
    return "REPORTED_COMPLETE_INTEGRITY_FAILURE";
  }
  if (ledgerRecomputation.state === "RECOMPUTED_AND_MATCHED") {
    return "REPORTED_COMPLETE_LEDGER_SUMMARY_RECOMPUTED";
  }
  return "REPORTED_COMPLETE_NOT_INDEPENDENTLY_REPRODUCED";
}

function unavailableLedgerRecomputation(verification) {
  const mapping = {
    HASH_MISMATCH: "INTEGRITY_FAILURE",
    MALFORMED: "MALFORMED",
    MISSING: "MISSING",
    UNVERIFIABLE: "UNVERIFIABLE",
  };
  return {
    calculationsRecomputed: [],
    state: mapping[verification?.state] ?? "UNVERIFIABLE",
    strategySignalsRerun: false,
  };
}

function fatalStatus(error, inventoryPath) {
  const failure = { id: "artifact-inventory", path: inventoryPath, state: "UNVERIFIABLE" };
  return {
    kind: "offline-research-decision-status",
    schemaVersion: 2,
    decision: "UNVERIFIABLE_REPORTED_DECISION",
    validatedEdge: false,
    implementationReadiness: "BLOCKED_STATUS_UNVERIFIABLE",
    evidenceHealth: {
      hasIntegrityFailure: false,
      integrityFailures: [],
      missingRequiredForReproduction: ["artifact-inventory"],
      overallState: "PUBLIC_PACKAGE_UNVERIFIABLE",
      publicPackage: {
        exitCode: 2,
        failures: [failure],
        state: "REQUIRED_EVIDENCE_UNAVAILABLE",
      },
      developmentReproduction: {
        exitCode: 2,
        failures: [failure],
        state: "REQUIRED_EVIDENCE_UNAVAILABLE",
      },
    },
    error,
    processState: "NOT_CHECKED_BY_OFFLINE_COMMAND",
    safety: {
      authenticates: false,
      executionAuthorized: false,
      startsCollectors: false,
      startsSearches: false,
      placesOrders: false,
      usesNetwork: false,
    },
  };
}

export async function buildResearchStatus({
  checkpointRelativePath = "data/market/historical-backfill-status.json",
  inventoryRelativePath = DEFAULT_ARTIFACT_INVENTORY,
  projectRoot,
  recomputeDevelopment = false,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required.");
  let inventory;
  try {
    const inventoryPath = path.resolve(projectRoot, ...inventoryRelativePath.split("/"));
    inventory = validateArtifactInventory(JSON.parse(await readFile(inventoryPath, "utf8")));
  } catch (error) {
    return fatalStatus(error.message, inventoryRelativePath);
  }

  const verifications = await Promise.all(
    inventory.artifacts.map((artifact) => verifyArtifact(projectRoot, artifact)),
  );
  const matrixArtifact = artifactById(inventory, "decision-matrix");
  const protocolArtifact = artifactById(inventory, "development-protocol");
  const summaryArtifact = artifactById(inventory, "development-summary");
  const ledgerArtifact = artifactById(inventory, "development-ledger");
  let matrix = await readVerifiedJson(
    projectRoot,
    matrixArtifact,
    verificationById(verifications, matrixArtifact.id),
  );
  if (matrix && !matrixIsUsable(matrix)) {
    replaceVerification(verifications, matrixArtifact.id, {
      error: "Decision matrix structure is malformed.",
      state: "MALFORMED",
    });
    matrix = null;
  }
  if (matrix) {
    for (const preserved of matrix.preservedEvidence ?? []) {
      const listed = inventory.artifacts.find((artifact) => artifact.path === preserved.path);
      if (!listed || listed.sha256 !== preserved.sha256) {
        replaceVerification(verifications, matrixArtifact.id, {
          error: `Artifact inventory conflicts with preserved matrix evidence: ${preserved.path}`,
          state: "MALFORMED",
        });
        matrix = null;
        break;
      }
    }
  }

  const protocolVerification = verificationById(verifications, protocolArtifact.id);
  const summaryVerification = verificationById(verifications, summaryArtifact.id);
  const ledgerVerification = verificationById(verifications, ledgerArtifact.id);
  const protocol = await readVerifiedJson(projectRoot, protocolArtifact, protocolVerification);
  const summary = await readVerifiedJson(projectRoot, summaryArtifact, summaryVerification);
  let publishedArtifacts = null;
  if (protocol && summary) {
    try {
      publishedArtifacts = validatePublishedDevelopmentArtifacts({
        protocol,
        protocolSha256: protocolVerification.actualSha256,
        summary,
      });
      if (publishedArtifacts.batchId !== inventory.developmentScreen.batchId ||
          publishedArtifacts.outcome !== inventory.developmentScreen.reportedOutcome) {
        throw new Error("Artifact inventory conflicts with the published batch or outcome.");
      }
      if (publishedArtifacts.ledger.finalPath !== ledgerArtifact.path ||
          publishedArtifacts.ledger.finalSha256 !== ledgerArtifact.sha256) {
        throw new Error("Artifact inventory conflicts with the published ledger identity.");
      }
    } catch (error) {
      replaceVerification(verifications, summaryArtifact.id, {
        error: error.message,
        state: "MALFORMED",
      });
    }
  }

  const publishedFinding = publishedArtifacts
    ? {
        batchId: publishedArtifacts.batchId,
        counts: publishedArtifacts.counts,
        dataset: publishedArtifacts.dataset,
        outcome: publishedArtifacts.outcome,
        reportedCompletion: publishedArtifacts.counts.uniqueConfigurationsCompleted ===
          publishedArtifacts.counts.uniqueConfigurationsPlanned &&
          publishedArtifacts.counts.failedTrials === 0,
        source: summaryArtifact.path,
        sourceState: "VERIFIED",
        status: "REPORTED_FINDING_FROM_VERIFIED_PUBLIC_SUMMARY",
      }
    : {
        counts: null,
        narrative: matrix?.priorSearch?.preciseConclusion ?? null,
        outcome: null,
        reportedCompletion: null,
        source: matrix ? matrixArtifact.path : null,
        sourceState: matrix ? "SECONDARY_SOURCE_ONLY" : "UNVERIFIABLE",
        status: "REPORTED_FINDING_SOURCE_UNVERIFIABLE",
      };

  let ledgerRecomputation = unavailableLedgerRecomputation(ledgerVerification);
  if (!recomputeDevelopment && ledgerVerification.state === "VERIFIED") {
    ledgerRecomputation = {
      calculationsRecomputed: [],
      state: "NOT_RUN",
      strategySignalsRerun: false,
    };
  } else if (publishedArtifacts && ledgerVerification.state === "VERIFIED") {
    ledgerRecomputation = await recomputeLedgerSummary({
      ledgerPath: resolveArtifactPath(projectRoot, ledgerArtifact.path),
      protocol,
      protocolSha256: protocolVerification.actualSha256,
      summary,
    });
  }
  const evaluatedSlice = recomputeDevelopment
    ? await verifyEvaluatedArchiveSlice(
        projectRoot,
        inventory.developmentScreen.evaluatedSlice,
      )
    : {
        expected: structuredClone(inventory.developmentScreen.evaluatedSlice),
        state: "NOT_CHECKED",
      };
  const historicalExpansion = await assessHistoricalExpansion({
    checkpointRelativePath,
    projectRoot,
  });
  const publicPackage = publicRequirement(inventory, verifications);
  const developmentReproduction = reproductionRequirement(
    inventory,
    verifications,
    ledgerRecomputation,
    evaluatedSlice,
  );
  const overallState = overallEvidenceState({
    ledger: ledgerRecomputation,
    publicPackage,
    reproduction: developmentReproduction,
    slice: evaluatedSlice,
    verifications,
  });
  const integrityFailures = [
    ...verifications
      .filter((item) => item.state === "HASH_MISMATCH")
      .map((item) => ({ id: item.id, path: item.path, state: item.state })),
    ...(ledgerRecomputation.state === "INTEGRITY_FAILURE"
      ? [{ id: "ledger-summary-recomputation", state: ledgerRecomputation.state }]
      : []),
    ...(["HASH_MISMATCH", "INTEGRITY_FAILURE"].includes(evaluatedSlice.state)
      ? [{ id: "evaluated-market-slice", state: evaluatedSlice.state }]
      : []),
  ];

  return {
    kind: "offline-research-decision-status",
    schemaVersion: 2,
    decision: matrix?.decision?.code ?? "UNVERIFIABLE_REPORTED_DECISION",
    validatedEdge: false,
    implementationReadiness: matrix?.decision?.implementationReadiness ??
      "BLOCKED_STATUS_UNVERIFIABLE",
    evidenceHealth: {
      developmentReproduction,
      hasIntegrityFailure: overallState === "INTEGRITY_FAILURE",
      integrityFailures,
      missingRequiredForReproduction: developmentReproduction.failures
        .filter((failure) => failure.state === "MISSING")
        .map((failure) => failure.id),
      overallState,
      publicPackage,
    },
    publishedResearch: {
      developmentScreen: publishedFinding,
      interpretation: {
        historicalFindingIsReportedEvenWhenLocalEvidenceIsMissing: true,
        matchingChecksumsAloneProveCalculationsCorrect: false,
        scope: matrix?.priorSearch?.hypothesisScope ?? null,
        universalUnprofitabilityEstablished: false,
      },
    },
    dataCompleteness: {
      developmentScreen: {
        artifactAvailability: ledgerVerification?.state ?? "UNVERIFIABLE",
        configurationsCompleted: publishedFinding.counts?.uniqueConfigurationsCompleted ?? null,
        evidenceState: ledgerVerification?.state ?? "UNVERIFIABLE",
        expectedLedgerSha256: ledgerArtifact.sha256,
        independentReproducibility: {
          evaluatedMarketSlice: evaluatedSlice,
          ledgerSummary: ledgerRecomputation,
          level: developmentReproduction.state === "VERIFIED_PARTIAL_REPRODUCTION"
            ? "PARTIAL_REPRODUCTION"
            : "NOT_REPRODUCED",
          originalStrategySimulationRerun: false,
        },
        localIntegrityVerification: {
          ledger: ledgerVerification?.state ?? "UNVERIFIABLE",
          protocol: verificationById(verifications, protocolArtifact.id)?.state ?? "UNVERIFIABLE",
          summary: verificationById(verifications, summaryArtifact.id)?.state ?? "UNVERIFIABLE",
        },
        reportedCompletion: publishedFinding.reportedCompletion,
        status: developmentStatus({
          ledgerRecomputation,
          ledgerVerification,
          published: publishedFinding,
        }),
      },
      historicalExpansion90Day: historicalExpansion,
    },
    classifications: matrix
      ? Object.fromEntries(matrix.directions.map((direction) => [
          direction.id,
          direction.classifications.map((item) => item.code),
        ]))
      : {},
    unresolvedBlockers: uniqueBlockers(matrix?.directions),
    holdout: matrix?.holdout ?? { status: "UNVERIFIABLE" },
    evidenceVerification: verifications,
    processState: "NOT_CHECKED_BY_OFFLINE_COMMAND",
    strictVerification: {
      normalModeExitCode: 0,
      public: publicPackage,
      reproduction: developmentReproduction,
    },
    safety: {
      authenticates: false,
      executionAuthorized: false,
      startsCollectors: false,
      startsSearches: false,
      placesOrders: false,
      usesNetwork: false,
    },
  };
}

export function strictExitCode(status, mode) {
  if (!STRICT_MODES.has(mode)) throw new Error(`Unsupported strict mode: ${mode}`);
  const result = status?.strictVerification?.[mode] ??
    status?.evidenceHealth?.[mode === "public" ? "publicPackage" : "developmentReproduction"];
  return Number.isInteger(result?.exitCode) ? result.exitCode : 2;
}
