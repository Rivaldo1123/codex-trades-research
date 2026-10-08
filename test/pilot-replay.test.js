import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { appendTickChunk } from "../src/data-store.js";
import { assertPilotWindowClosed, evaluatePilotTicks, runPilotReplay,
  validatePilotProtocol } from "../src/pilot-replay.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(projectRoot, "data", "market",
  "forward-protocol-2026-10-07-v3-pilot.json");
const expectedHash = "3847b023023dbe5434fb23b71cad4a6d376f42fe26393e605348a1267722979e";
const endMs = Date.parse("2026-10-08T00:00:00Z");

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-replay-"));
  const market = path.join(root, "data", "market");
  await mkdir(market, { recursive: true });
  const bytes = await readFile(protocolPath);
  const pinnedProtocol = path.join(market, "forward-protocol-2026-10-07-v3-pilot.json");
  await writeFile(pinnedProtocol, bytes);
  await writeFile(path.join(root, "config.data.json"), JSON.stringify({
    mode: "public-data-only", symbol: "1HZ100V",
    endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
  }));
  await writeFile(path.join(market, "live-collector-status.json"), JSON.stringify({
    state: "COMPLETED", mode: "public-data-only", collectionMode: "forward-only",
    finalization: { requested: false, state: "NOT_REQUESTED" },
    symbol: "1HZ100V", endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
    startedAt: "2026-10-07T16:59:00.000Z", endsAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:01.000Z", pid: 123,
    ticksReceived: 25_200, ticksStored: 25_200, chunksStored: 1,
  }));
  return { root, pinnedProtocol };
}

test("v3 short-pilot protocol is SHA-pinned, prospective and public-only", async () => {
  const bytes = await readFile(protocolPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
  const protocol = JSON.parse(bytes);
  const window = validatePilotProtocol(protocol);
  assert.equal(window.expectedSeconds, 25_200);
  assert.equal(new Date(window.toEpochExclusive * 1_000).toISOString(),
    "2026-10-08T00:00:00.000Z");
  assert.throws(() => validatePilotProtocol({ ...protocol,
    source: { ...protocol.source, endpoint: "wss://api.derivws.com/trading/v1/options/ws/demo" } }),
  /public-only safety lock/);
  assert.throws(() => validatePilotProtocol({ ...protocol,
    candidateRules: protocol.candidateRules.slice(1) }), /fixed candidate/);
});

test("pilot replay refuses every timestamp before 8 pm New York cutoff", async () => {
  assert.throws(() => assertPilotWindowClosed(endMs / 1_000, endMs - 1),
    /has not closed/);
  assert.doesNotThrow(() => assertPilotWindowClosed(endMs / 1_000, endMs));
  const { root, pinnedProtocol } = await fixtureRoot();
  try {
    await assert.rejects(runPilotReplay({ projectRoot: root, protocolPath: pinnedProtocol,
      expectedProtocolSha256: expectedHash, nowMs: endMs - 1 }), /has not closed/);
    await assert.rejects(runPilotReplay({ projectRoot: root, protocolPath: pinnedProtocol,
      expectedProtocolSha256: "0".repeat(64), nowMs: endMs + 1 }), /checksum changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pilot evaluates exactly 18 fixed descriptive scenarios without a trading gate", () => {
  const fromEpoch = 1_700_000_000;
  const quotes = Float64Array.from(Array.from({ length: 300 }, (_, index) =>
    100 + Math.sin(index / 7) * 4));
  const present = Uint8Array.from(Array(300).fill(1));
  present[50] = 0;
  const result = evaluatePilotTicks({ quotes, present, fromEpoch,
    toEpochExclusive: fromEpoch + quotes.length });
  assert.equal(result.scenarioLedger.length, 18);
  assert.equal(result.model.oneOpenHypotheticalContract, true);
  assert.equal(result.model.bootstrapRepetitions, undefined);
  assert.deepEqual(new Set(result.scenarioLedger.map((item) => item.candidateId)),
    new Set(["bb20-2-reversal-5t", "rsi14-reversal-5t"]));
  for (const item of result.scenarioLedger) {
    assert.equal(item.fullWindow.settledTrades,
      item.fullWindow.wins + item.fullWindow.losses);
    assert.equal(item.fullWindow.settledTrades,
      item.firstHalf.settledTrades + item.secondHalf.settledTrades);
    assert.ok(item.fullWindow.noTradeTicks >= 0);
    assert.ok(item.fullWindow.ties <= item.fullWindow.losses);
  }
});

test("completed public collector, exact-row audit and one-time report are mandatory", async () => {
  const { root, pinnedProtocol } = await fixtureRoot();
  const protocol = JSON.parse(await readFile(pinnedProtocol, "utf8"));
  const { fromEpoch, toEpochExclusive } = validatePilotProtocol(protocol);
  try {
    await writeFile(path.join(root, "data", "market", "collector.lock"), "123\n");
    await assert.rejects(runPilotReplay({ projectRoot: root, protocolPath: pinnedProtocol,
      expectedProtocolSha256: expectedHash, nowMs: endMs + 1 }), /lock remains/);
    await rm(path.join(root, "data", "market", "collector.lock"));

    const ticks = Array.from({ length: 25_200 }, (_, index) => ({
      epoch: fromEpoch + index, quote: 100 + Math.sin(index / 7) * 4,
    }));
    await appendTickChunk(root, "1HZ100V", ticks);
    const { report, reportPath } = await runPilotReplay({ projectRoot: root,
      protocolPath: pinnedProtocol, expectedProtocolSha256: expectedHash,
      nowMs: endMs + 1 });
    assert.equal(report.decision, "DEVELOPMENT_ONLY");
    assert.equal(report.scenarioLedger.length, 18);
    assert.equal(report.audit.coverage, 1);
    assert.deepEqual(report.audit.missingRanges, []);
    assert.equal(report.botBuilderRunPermission, false);
    assert.equal(report.demoOrderPermission, false);
    assert.equal(report.realOrderPermission, false);
    assert.ok(report.limitations.some((item) => item.includes("not evidence")));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).decision,
      "DEVELOPMENT_ONLY");
    await assert.rejects(runPilotReplay({ projectRoot: root,
      protocolPath: pinnedProtocol, expectedProtocolSha256: expectedHash,
      nowMs: endMs + 2 }), (error) => error.code === "EEXIST");
    assert.equal(toEpochExclusive - fromEpoch, 25_200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("insufficient genuine-second coverage is INCONCLUSIVE, not a replay or permission", async () => {
  const { root, pinnedProtocol } = await fixtureRoot();
  const protocol = JSON.parse(await readFile(pinnedProtocol, "utf8"));
  const { fromEpoch } = validatePilotProtocol(protocol);
  try {
    const ticks = Array.from({ length: 25_200 }, (_, index) => ({
      epoch: fromEpoch + index, quote: 100 + index / 100_000,
    })).filter((tick) => tick.epoch < fromEpoch + 100 || tick.epoch >= fromEpoch + 130);
    await appendTickChunk(root, "1HZ100V", ticks);
    const { report } = await runPilotReplay({ projectRoot: root,
      protocolPath: pinnedProtocol, expectedProtocolSha256: expectedHash,
      nowMs: endMs + 1 });
    assert.equal(report.audit.missingSeconds, 30);
    assert.equal(report.audit.missingRanges.length, 1);
    assert.equal(report.decision, "INCONCLUSIVE");
    assert.deepEqual(report.scenarioLedger, []);
    assert.equal(report.botBuilderRunPermission, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
