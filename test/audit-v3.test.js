import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, ...relativePath.split("/")), "utf8"));
}

test("v3 audit preserves original evidence identity and keeps deployment blocked", async () => {
  const audit = await readJson(
    "research/audits/execution-and-strategy-path-audit-v3-2026-10-08.json",
  );
  const inventory = await readJson(
    "research/reproducibility/development-screen-v1-artifact-inventory.json",
  );
  const deployment = await readJson(
    "research/deployment/active-demo-candidate.json",
  );
  const ledger = inventory.artifacts.find((artifact) => artifact.id === "development-ledger");
  assert.equal(audit.originalEvidence.ledgerSha256, ledger.sha256);
  assert.equal(audit.originalEvidence.ledgerBytes, ledger.bytes);
  assert.equal(audit.originalEvidence.strategySignalsRerun, false);
  assert.equal(audit.ordersPlaced, 0);
  assert.equal(audit.authenticatedRequests, 0);
  assert.ok(audit.rankedDirections.length <= 3);
  assert.equal(audit.decision.code, "NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS");
  assert.equal(audit.decision.boundedExperimentRun, false);
  assert.equal(deployment.executionAuthorized, false);
  assert.equal(deployment.state, "NO_QUALIFIED_CANDIDATE");
  assert.equal(deployment.candidate, null);
});

test("v3 compact public artifacts match their machine inventory", async () => {
  const inventory = await readJson(
    "research/reproducibility/execution-audit-v3-artifact-inventory.json",
  );
  for (const artifact of inventory.artifacts) {
    const bytes = await readFile(path.join(root, ...artifact.path.split("/")));
    assert.equal(bytes.length, artifact.bytes, artifact.id);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),
      artifact.sha256, artifact.id);
  }
});
