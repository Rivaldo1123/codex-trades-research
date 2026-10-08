import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildResearchStatus } from "../src/research-status.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("offline decision status distinguishes blockers and cannot start trading work", async () => {
  const status = await buildResearchStatus({ projectRoot });
  assert.equal(status.decision, "NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS");
  assert.equal(status.validatedEdge, false);
  assert.equal(status.implementationReadiness, "NOT_READY_NO_VALIDATED_EDGE");
  assert.deepEqual(status.safety, {
    authenticates: false,
    startsCollectors: false,
    startsSearches: false,
    placesOrders: false,
    usesNetwork: false,
  });
  assert.ok(status.classifications["range-break-boundary-state"]
    .includes("SPECIFICATION_CONFLICT"));
  assert.ok(status.classifications["drift-volatility-switch-regimes"]
    .includes("INSUFFICIENT_EXECUTION_DATA"));
  assert.equal(status.holdout.status, "NOT_ASSIGNED");
  assert.notEqual(status.dataCompleteness.historicalExpansion90Day.complete, true);
});

test("all tracked preserved evidence hashes match and missing ignored evidence is explicit", async () => {
  const status = await buildResearchStatus({ projectRoot });
  const tracked = status.evidenceVerification.filter((item) =>
    item.path !== "data/research/development-screen-v1/ledger.final.jsonl");
  assert.ok(tracked.length > 0);
  assert.ok(tracked.every((item) => item.state === "VERIFIED"));
  const ledger = status.evidenceVerification.find((item) =>
    item.path === "data/research/development-screen-v1/ledger.final.jsonl");
  assert.ok(["VERIFIED", "LOCAL_EVIDENCE_UNAVAILABLE"].includes(ledger.state));
});

test("tracked trading templates and browser gate remain disarmed after the feasibility decision", async () => {
  const demoConfig = JSON.parse(await readFile(
    path.join(projectRoot, "config.demo.template.json"),
    "utf8",
  ));
  const browserGate = JSON.parse(await readFile(path.join(
    projectRoot,
    "data",
    "browser-bot",
    "run-gate.json",
  ), "utf8"));
  assert.equal(demoConfig.executionEnabled, false);
  assert.equal(demoConfig.realEndpointAllowed, false);
  assert.equal(browserGate.decision, "WAIT");
  assert.equal(browserGate.eligibleForSignalCheck, false);
});
