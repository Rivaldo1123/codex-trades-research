import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MATRIX_PATH = path.join(
  "research",
  "feasibility",
  "evidence-blocker-matrix-v2-2026-10-08.json",
);
const BACKFILL_STATUS_PATH = path.join("data", "market", "historical-backfill-status.json");

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyEvidence(projectRoot, evidence) {
  const absolutePath = path.join(projectRoot, ...evidence.path.split("/"));
  try {
    const actualSha256 = await hashFile(absolutePath);
    return {
      actualSha256,
      expectedSha256: evidence.sha256,
      name: evidence.name,
      path: evidence.path,
      state: actualSha256 === evidence.sha256 ? "VERIFIED" : "HASH_MISMATCH",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        expectedSha256: evidence.sha256,
        name: evidence.name,
        path: evidence.path,
        state: "LOCAL_EVIDENCE_UNAVAILABLE",
      };
    }
    throw error;
  }
}

function uniqueBlockers(directions) {
  return [...new Set(directions.flatMap((direction) => direction.blockers ?? []))].sort();
}

export async function buildResearchStatus({ projectRoot }) {
  if (!projectRoot) throw new Error("projectRoot is required.");
  const matrixPath = path.join(projectRoot, ...MATRIX_PATH.split(path.sep));
  const matrix = await readJsonIfPresent(matrixPath);
  if (!matrix) throw new Error(`Missing verified decision matrix: ${MATRIX_PATH}`);

  const evidence = await Promise.all(
    matrix.preservedEvidence.map((item) => verifyEvidence(projectRoot, item)),
  );
  const ledger = evidence.find((item) => item.name === "original development ledger");
  const backfill = await readJsonIfPresent(path.join(projectRoot, BACKFILL_STATUS_PATH));

  return {
    kind: "offline-research-decision-status",
    schemaVersion: 1,
    decision: matrix.decision.code,
    validatedEdge: matrix.decision.validatedEdge,
    implementationReadiness: matrix.decision.implementationReadiness,
    dataCompleteness: {
      developmentScreen: {
        configurationsCompleted: 12012,
        evidenceState: ledger?.state ?? "LOCAL_EVIDENCE_UNAVAILABLE",
        expectedLedgerSha256: ledger?.expectedSha256,
        status: "COMPLETE_FROZEN_DEVELOPMENT_EVIDENCE",
      },
      historicalExpansion90Day: backfill
        ? {
            complete: false,
            cursorEpoch: backfill.cursorEpoch,
            lastError: backfill.lastError,
            pagesFetched: backfill.pagesFetched,
            rowsStored: backfill.rowsStored,
            state: backfill.state,
            target: [backfill.fromEpoch, backfill.toEpochExclusive],
          }
        : {
            complete: false,
            state: "LOCAL_CHECKPOINT_UNAVAILABLE",
          },
    },
    classifications: Object.fromEntries(matrix.directions.map((direction) => [
      direction.id,
      direction.classifications.map((item) => item.code),
    ])),
    unresolvedBlockers: uniqueBlockers(matrix.directions),
    holdout: matrix.holdout,
    evidenceVerification: evidence,
    processState: "NOT_CHECKED_BY_OFFLINE_COMMAND",
    safety: {
      authenticates: false,
      startsCollectors: false,
      startsSearches: false,
      placesOrders: false,
      usesNetwork: false,
    },
  };
}
