import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("connectivity incident preserves accounting while rejecting strategy evidence", async () => {
  const audit = JSON.parse(await readFile(
    path.join(root, "research", "audits", "demo-connectivity-incident-2026-10-08.json"),
    "utf8",
  ));
  assert.equal(audit.incidentDisposition, "ABORTED_CONNECTIVITY_LOSS");
  assert.equal(audit.strategyEvidenceEligible, false);
  assert.equal(audit.executionAuthorizedByThisRecord, false);
  assert.equal(audit.brokerObservation.purchases, 12);
  assert.equal(audit.brokerObservation.terminalContracts, 12);
  assert.equal(audit.brokerObservation.openContractsAtFinalCheck, 0);
  assert.equal(audit.brokerObservation.aggregateDemoProfitUsd, 8.51);
  assert.deepEqual(audit.brokerObservation.stakeCounts, { "1": 8, "2": 3, "4": 1 });
  assert.deepEqual(audit.brokerObservation.observedDurationCountsSeconds, {
    "6": 4,
    "300": 8,
  });
  assert.equal(audit.evidence.trackedInGit, false);
  assert.equal(audit.evidence.containsSensitiveBrokerIdentities, true);
  assert.match(audit.interpretation, /ineligible for performance or qualification evidence/);
});
