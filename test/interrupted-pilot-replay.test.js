import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { appendTickChunk } from "../src/data-store.js";
import { deriveForwardSignals, replayForwardHalf } from "../src/forward-replay.js";
import { runInterruptedPilotReplay, validateTerminatedPilotCollector } from
  "../src/interrupted-pilot-replay.js";
import { validatePilotProtocol } from "../src/pilot-replay.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceProtocolPath = path.join(projectRoot, "data", "market",
  "forward-protocol-2026-10-07-v3-pilot.json");
const expectedProtocolSha256 =
  "3847b023023dbe5434fb23b71cad4a6d376f42fe26393e605348a1267722979e";
const endMs = Date.parse("2026-10-08T00:00:00Z");
const LIVE_SOURCE = "Deriv public live tick subscription";

async function fixtureRoot(state = "COMPLETED") {
  const root = await mkdtemp(path.join(os.tmpdir(), "interrupted-pilot-"));
  const market = path.join(root, "data", "market");
  await mkdir(market, { recursive: true });
  const protocolBytes = await readFile(sourceProtocolPath);
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  const { fromEpoch, toEpochExclusive } = validatePilotProtocol(protocol);
  const protocolPath = path.join(market, "forward-protocol-2026-10-07-v3-pilot.json");
  await writeFile(protocolPath, protocolBytes);
  await writeFile(path.join(root, "config.data.json"), JSON.stringify({
    mode: "public-data-only", symbol: "1HZ100V",
    endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
  }));
  const status = {
    state, mode: "public-data-only", collectionMode: "forward-only",
    finalization: { requested: false, state: "NOT_REQUESTED" },
    symbol: "1HZ100V", endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
    startedAt: "2026-10-07T16:43:00.000Z", endsAt: "2026-10-08T00:00:00.000Z",
    updatedAt: state === "COMPLETED" ? "2026-10-08T00:00:01.000Z" :
      "2026-10-07T19:07:00.000Z",
    pid: 987_654_321, ticksReceived: 1_000, ticksStored: 900, chunksStored: 3,
    reconnects: 8, lastTickEpoch: fromEpoch + 900,
    lastError: state === "FAILED" ? "RateLimit: public ticks" : null,
  };
  await writeFile(path.join(market, "live-collector-status.json"), JSON.stringify(status));
  return { root, market, protocolPath, protocol, fromEpoch, toEpochExclusive, status };
}

function pricesWithGap(fromEpoch, length, gapStart, gapEndExclusive) {
  return Array.from({ length }, (_, offset) => ({
    epoch: fromEpoch + offset,
    quote: 100 + Math.sin(offset / 7) * 4 + Math.sin(offset / 19),
  })).filter((tick) => tick.epoch < gapStart || tick.epoch >= gapEndExclusive);
}

test("interrupted fallback checks the frozen v3 hash and forbids inspection before cutoff", async () => {
  const bytes = await readFile(sourceProtocolPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedProtocolSha256);
  await assert.rejects(runInterruptedPilotReplay({ projectRoot: "unreadable-root",
    protocolPath: sourceProtocolPath, expectedProtocolSha256,
    nowMs: endMs - 1 }), /has not closed/);
  await assert.rejects(runInterruptedPilotReplay({ projectRoot: "unreadable-root",
    protocolPath: sourceProtocolPath, expectedProtocolSha256: "0".repeat(64),
    nowMs: endMs + 1 }), /checksum changed/);
});

test("terminal public-only collector and absent lock/dead PID are mandatory", async () => {
  const fixture = await fixtureRoot("FAILED");
  try {
    assert.equal(validateTerminatedPilotCollector(fixture.status, fixture.protocol,
      () => false).state, "FAILED");
    assert.throws(() => validateTerminatedPilotCollector(fixture.status, fixture.protocol,
      () => true), /still alive/);
    assert.throws(() => validateTerminatedPilotCollector({ ...fixture.status,
      endpoint: "wss://api.derivws.com/trading/v1/options/ws/demo" },
    fixture.protocol, () => false), /safety lock/);
    await writeFile(path.join(fixture.market, "collector.lock"), "987654321\n");
    await assert.rejects(runInterruptedPilotReplay({ projectRoot: fixture.root,
      protocolPath: fixture.protocolPath, expectedProtocolSha256,
      nowMs: endMs + 1, isCollectorAlive: () => false }), /lock remains/);
    await rm(path.join(fixture.market, "collector.lock"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("120 absent seconds stay absent; all 18 fixed scenarios remain development-only", async () => {
  const fixture = await fixtureRoot("COMPLETED");
  try {
    const gapStart = fixture.fromEpoch + 5_000;
    const gapEndExclusive = gapStart + 120;
    const ticks = pricesWithGap(fixture.fromEpoch, 25_200, gapStart, gapEndExclusive);
    await appendTickChunk(fixture.root, "1HZ100V", ticks, { source: LIVE_SOURCE });
    const { report, reportPath } = await runInterruptedPilotReplay({
      projectRoot: fixture.root, protocolPath: fixture.protocolPath,
      expectedProtocolSha256, nowMs: endMs + 1,
      isCollectorAlive: () => false,
    });
    assert.equal(report.decision, "INCOMPLETE_DEVELOPMENT_ONLY");
    assert.equal(report.collector.state, "COMPLETED");
    assert.equal(report.audit.expectedSeconds, 25_200);
    assert.equal(report.audit.observedGenuineSeconds, 25_080);
    assert.equal(report.audit.missingSeconds, 120);
    assert.deepEqual(report.audit.missingRanges,
      [{ fromEpoch: gapStart, toEpochExclusive: gapEndExclusive, missingSeconds: 120 }]);
    assert.equal(report.rowLevelAudit.state, "INCONCLUSIVE");
    assert.equal(report.rowLevelAudit.duplicateRows, 0);
    assert.equal(report.rowLevelAudit.conflictingRows, 0);
    assert.equal(report.scenarioLedger.length, 18);
    assert.deepEqual(new Set(report.scenarioLedger.map((item) => item.candidateId)),
      new Set(["bb20-2-reversal-5t", "rsi14-reversal-5t"]));
    assert.ok(report.scenarioLedger.every((item) => item.fullWindow.settledTrades ===
      item.fullWindow.wins + item.fullWindow.losses));
    for (const key of ["botBuilderRunPermission", "demoOrderPermission",
      "realOrderPermission", "accountOrTokenUsePermission"]) {
      assert.equal(report[key], false);
    }
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).decision,
      "INCOMPLETE_DEVELOPMENT_ONLY");
    await assert.rejects(runInterruptedPilotReplay({ projectRoot: fixture.root,
      protocolPath: fixture.protocolPath, expectedProtocolSha256,
      nowMs: endMs + 2, isCollectorAlive: () => false }),
    (error) => error.code === "EEXIST");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("BB/RSI warmup resets after gaps and halves, and no replayed trade spans a gap", () => {
  const fromEpoch = 1_700_000_000;
  const quotes = Float64Array.from(Array.from({ length: 500 }, (_, index) =>
    100 + Math.sin(index / 5) * 8));
  const present = Uint8Array.from(Array(500).fill(1));
  present.fill(0, 180, 300); // An exact two-minute missing-tick interval.
  const midpoint = 250;
  const first = deriveForwardSignals(quotes.subarray(0, midpoint),
    present.subarray(0, midpoint));
  const second = deriveForwardSignals(quotes.subarray(midpoint),
    present.subarray(midpoint));
  for (const signal of [first.bb, first.rsi]) {
    assert.equal(signal[180], 0);
    assert.equal(signal[249], 0);
  }
  for (const signal of [second.bb, second.rsi]) {
    assert.equal(signal[50], 0);
  }
  assert.deepEqual([...second.bb.slice(50, 69)], Array(19).fill(0));
  assert.deepEqual([...second.rsi.slice(50, 64)], Array(14).fill(0));
  for (const signals of [first.bb, first.rsi]) {
    const replay = replayForwardHalf({ quotes, present, signals: Uint8Array.from([
      ...signals, ...Array(250).fill(0)]), fromEpoch, startIndex: 0,
    endExclusive: midpoint, delayTicks: 3, captureTrades: true });
    assert.ok(replay.trades.every((trade) => trade.settlementEpoch < fromEpoch + 180));
  }
});

test("non-live archived provenance is rejected", async () => {
  const fixture = await fixtureRoot("FAILED");
  try {
    await appendTickChunk(fixture.root, "1HZ100V",
      [{ epoch: fixture.fromEpoch, quote: 100 }]);
    await assert.rejects(runInterruptedPilotReplay({ projectRoot: fixture.root,
      protocolPath: fixture.protocolPath, expectedProtocolSha256,
      nowMs: endMs + 1, isCollectorAlive: () => false }), /not labelled as a public live/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a changed compressed chunk fails SHA-256 verification before replay", async () => {
  const fixture = await fixtureRoot("FAILED");
  try {
    await appendTickChunk(fixture.root, "1HZ100V",
      [{ epoch: fixture.fromEpoch, quote: 100 }], { source: LIVE_SOURCE });
    const archiveDirectory = path.join(fixture.market, "1HZ100V");
    const manifest = JSON.parse(await readFile(path.join(archiveDirectory, "manifest.json"),
      "utf8"));
    await writeFile(path.join(archiveDirectory, manifest.chunks[0].file), "corrupt archive");
    await assert.rejects(runInterruptedPilotReplay({ projectRoot: fixture.root,
      protocolPath: fixture.protocolPath, expectedProtocolSha256,
      nowMs: endMs + 1, isCollectorAlive: () => false }), /checksum failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed collector still permits a labelled, checksum-verified incomplete research report", async () => {
  const fixture = await fixtureRoot("FAILED");
  try {
    await appendTickChunk(fixture.root, "1HZ100V",
      pricesWithGap(fixture.fromEpoch, 1_000, fixture.fromEpoch + 500,
        fixture.fromEpoch + 620), { source: LIVE_SOURCE });
    const { report } = await runInterruptedPilotReplay({ projectRoot: fixture.root,
      protocolPath: fixture.protocolPath, expectedProtocolSha256,
      nowMs: endMs + 1, isCollectorAlive: () => false });
    assert.equal(report.collector.state, "FAILED");
    assert.equal(report.collector.lastError, "RateLimit: public ticks");
    assert.equal(report.decision, "INCOMPLETE_DEVELOPMENT_ONLY");
    assert.equal(report.scenarioLedger.length, 18);
    assert.ok(report.audit.missingSeconds > 120);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
