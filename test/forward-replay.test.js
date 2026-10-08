import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { appendTickChunk } from "../src/data-store.js";
import { assertForwardWindowClosed, auditForwardArchive, bollingerAt, deriveForwardSignals,
  evaluateForwardTicks, hourlyBootstrapLowerBound, replayForwardHalf,
  rsiAt, scoreForwardCounts, validateCompletedForwardCollectorStatus,
  validateForwardProtocol,
  verifyPlatformParity } from "../src/forward-replay.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(projectRoot, "data", "market", "forward-protocol-2026-10-07-v2.json");

test("the immutable v2 protocol has the expected public, prospective, two-method shape", async () => {
  const bytes = await readFile(protocolPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, "5e5fbcc219f1071895e259ade4e6f603b43170087fcbea98d60545f6665ccc56");
  const protocol = JSON.parse(bytes.toString("utf8"));
  const window = validateForwardProtocol(protocol);
  assert.equal(window.expectedSeconds, 1_209_060);
  assert.equal(new Date(window.fromEpoch * 1_000).toISOString(), "2026-10-07T15:56:00.000Z");
  assert.equal(new Date(window.toEpochExclusive * 1_000).toISOString(), "2026-10-21T15:47:00.000Z");
  assert.throws(() => validateForwardProtocol({ ...protocol,
    source: { ...protocol.source, endpoint: "wss://api.derivws.com/trading/v1/options/ws/demo" } }),
    /safety or public-endpoint lock/);
  assert.throws(() => validateForwardProtocol({ ...protocol,
    candidateRules: protocol.candidateRules.slice(0, 1) }), /candidate set/);
});

test("completed forward-only collector accepts equivalent UTC formatting and rejects legacy finalization", async () => {
  const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
  const status = { state: "COMPLETED", mode: "public-data-only",
    collectionMode: "forward-only", finalization: { requested: false,
      state: "NOT_REQUESTED" }, symbol: "1HZ100V",
    endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
    endsAt: "2026-10-21T15:47:00.000Z", startedAt: "2026-10-07T15:52:00.000Z",
    updatedAt: "2026-10-21T15:47:02.000Z" };
  assert.equal(validateCompletedForwardCollectorStatus(status, protocol).collectionMode,
    "forward-only");
  assert.throws(() => validateCompletedForwardCollectorStatus({ ...status,
    collectionMode: "legacy-catchup" }, protocol), /did not complete/);
  assert.throws(() => validateCompletedForwardCollectorStatus({ ...status,
    finalization: { requested: true } }, protocol), /did not complete/);
  assert.throws(() => validateCompletedForwardCollectorStatus({ ...status,
    endsAt: "2026-10-21T15:48:00.000Z" }, protocol), /did not complete/);
});

test("BB uses the current tick and population SD, with strict thresholds", () => {
  const ascending = Array.from({ length: 20 }, (_, index) => index);
  const band = bollingerAt(ascending, 19);
  const sigma = Math.sqrt(33.25);
  assert.ok(Math.abs(band.middle - 9.5) < 1e-12);
  assert.ok(Math.abs(band.upper - (9.5 + 2 * sigma)) < 1e-12);
  assert.ok(Math.abs(band.lower - (9.5 - 2 * sigma)) < 1e-12);
  assert.equal(bollingerAt(ascending, 18), null);
  const outlier = [...Array(19).fill(0), 10];
  const signals = deriveForwardSignals(Float64Array.from(outlier), Uint8Array.from(Array(20).fill(1)));
  assert.equal(signals.bb[18], 0);
  assert.equal(signals.bb[19], 2);
});

test("Wilder RSI is seeded by 14 differences, includes current tick and resets at a gap", () => {
  const rising = Array.from({ length: 15 }, (_, index) => index);
  const falling = Array.from({ length: 15 }, (_, index) => 20 - index);
  assert.equal(rsiAt(rising, 13), null);
  assert.equal(rsiAt(rising, 14), 100);
  assert.equal(rsiAt(falling, 14), 0);
  assert.equal(rsiAt(Array(15).fill(42), 14), 50);
  const balanced = [0];
  for (let i = 1; i <= 14; i += 1) balanced.push(balanced.at(-1) + (i % 2 ? 1 : -1));
  assert.equal(rsiAt(balanced, 14), 50);
  balanced.push(balanced.at(-1) + 1);
  assert.ok(Math.abs(rsiAt(balanced, 15) - 53.57142857142857) < 1e-12);

  const quotes = Float64Array.from([...falling, 999, ...falling]);
  const present = Uint8Array.from(Array(quotes.length).fill(1));
  present[15] = 0;
  const signals = deriveForwardSignals(quotes, present);
  assert.equal(signals.rsi[14], 1);
  assert.equal(signals.rsi[15], 0);
  assert.equal(signals.rsi[29], 0);
  assert.equal(signals.rsi[30], 1);
});

test("replay allows only one open contract, skips a future gap and counts ties as losses", () => {
  const quotes = Float64Array.from(Array.from({ length: 35 }, (_, index) => index));
  const present = Uint8Array.from(Array(35).fill(1));
  present[8] = 0;
  quotes[15] = quotes[10];
  const signals = Uint8Array.from(Array(35).fill(1));
  const replay = replayForwardHalf({ quotes, present, signals, fromEpoch: 1_700_000_000,
    startIndex: 0, endExclusive: 35, delayTicks: 1, captureTrades: true });
  assert.equal(replay.trades[0].signalEpoch, 1_700_000_000);
  assert.equal(replay.trades[0].entryEpoch, 1_700_000_001);
  assert.equal(replay.trades[0].settlementEpoch, 1_700_000_006);
  assert.ok(replay.counts.skippedForGap > 0);
  for (let i = 1; i < replay.trades.length; i += 1) {
    assert.ok(replay.trades[i].signalEpoch > replay.trades[i - 1].settlementEpoch);
  }
  for (const trade of replay.trades) {
    assert.ok(trade.settlementEpoch < 1_700_000_008 || trade.signalEpoch > 1_700_000_008);
  }
  assert.equal(replay.counts.wins + replay.counts.losses, replay.counts.settledTrades);
  assert.equal(replay.counts.ties, replay.trades.filter((trade) => trade.tie).length);
  assert.ok(replay.counts.ties >= 1);
  assert.equal(scoreForwardCounts(replay.counts, 0.8).netProfitPerDollarStake,
    replay.counts.wins * 0.8 - replay.counts.losses);
});

test("replay labels two-second streams with actual UTC tick spacing", () => {
  const quotes = Float64Array.from(Array.from({ length: 20 }, (_, index) => index));
  const present = Uint8Array.from(Array(20).fill(1));
  const signals = Uint8Array.from(Array(20).fill(1));
  const replay = replayForwardHalf({ quotes, present, signals, fromEpoch: 1_700_000_000,
    startIndex: 0, endExclusive: 20, delayTicks: 2, secondsPerTick: 2,
    captureTrades: true });
  assert.deepEqual(replay.trades[0], { signalEpoch: 1_700_000_000,
    entryEpoch: 1_700_000_004, settlementEpoch: 1_700_000_014,
    direction: "Rise", won: true, tie: false });
});

test("decision, delayed entry and settlement cannot cross a chronological half", () => {
  const quotes = Float64Array.from(Array.from({ length: 20 }, (_, index) => index));
  const present = Uint8Array.from(Array(20).fill(1));
  const signals = Uint8Array.from(Array(20).fill(1));
  const first = replayForwardHalf({ quotes, present, signals, fromEpoch: 0,
    startIndex: 0, endExclusive: 10, delayTicks: 1, captureTrades: true });
  const second = replayForwardHalf({ quotes, present, signals, fromEpoch: 0,
    startIndex: 10, endExclusive: 20, delayTicks: 1, captureTrades: true });
  assert.equal(first.trades.length, 1);
  assert.ok(first.trades.every((trade) => trade.settlementEpoch < 10));
  assert.ok(second.trades.every((trade) => trade.signalEpoch >= 10));
});

test("hourly bootstrap is deterministic, includes zero-trade hours and reports a lower bound", () => {
  const hourly = new Map(Array.from({ length: 7 }, (_, hour) =>
    [hour, { wins: 8, losses: 0 }]));
  const first = hourlyBootstrapLowerBound(hourly, 0, 8 * 3_600,
    { repetitions: 200, seed: 20_261_007 });
  const second = hourlyBootstrapLowerBound(hourly, 0, 8 * 3_600,
    { repetitions: 200, seed: 20_261_007 });
  assert.deepEqual(first, second);
  assert.equal(first.numberOfBlocks, 8);
  assert.ok(first.lowerBound > 0);
});

test("small synthetic dataset evaluates exactly two candidates x three delays x three payouts and stays disarmed", () => {
  const quotes = Float64Array.from(Array.from({ length: 200 }, (_, index) =>
    100 + Math.sin(index / 5) * 5));
  const present = Uint8Array.from(Array(200).fill(1));
  const result = evaluateForwardTicks({ quotes, present, fromEpoch: 1_700_000_000,
    toEpochExclusive: 1_700_000_200, bootstrapRepetitions: 100 });
  assert.equal(result.scenarioLedger.length, 18);
  assert.equal(result.candidateDecisions.length, 2);
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.botBuilderRunPermission, false);
});

test("row-level audit reports every missing range and rejects checksum or duplicate evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forward-replay-audit-"));
  try {
    const fromEpoch = 1_700_000_000;
    const ticks = Array.from({ length: 100 }, (_, index) =>
      ({ epoch: fromEpoch + index, quote: 100 + index }))
      .filter((tick) => tick.epoch !== fromEpoch + 50);
    const { chunk } = await appendTickChunk(root, "1HZ100V", ticks);
    const input = { projectRoot: root, symbol: "1HZ100V", fromEpoch,
      toEpochExclusive: fromEpoch + 100 };
    const result = await auditForwardArchive(input);
    assert.equal(result.audit.observedGenuineSeconds, 99);
    assert.deepEqual(result.audit.missingRanges, [{ fromEpoch: fromEpoch + 50,
      toEpochExclusive: fromEpoch + 51, missingSeconds: 1 }]);

    await appendTickChunk(root, "1HZ100V", [{ epoch: fromEpoch + 51, quote: 151 },
      { epoch: fromEpoch + 52, quote: 152 }]);
    await assert.rejects(auditForwardArchive(input), /duplicate or quote conflict/);

    const chunkPath = path.join(root, "data", "market", "1HZ100V", chunk.file);
    const bytes = await readFile(chunkPath);
    bytes[0] ^= 1;
    await writeFile(chunkPath, bytes);
    await assert.rejects(auditForwardArchive(input), /checksum failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform parity requires actual matching BB/RSI vectors and explicit tick-timing evidence", () => {
  const bbOne = Array.from({ length: 20 }, (_, index) => index);
  const bbTwo = [...Array(19).fill(0), 10];
  const rsiOne = Array.from({ length: 15 }, (_, index) => index);
  const rsiTwo = Array.from({ length: 15 }, (_, index) => 15 - index);
  const proof = { kind: "deriv-bot-builder-platform-parity", protocolSha256: "a".repeat(64),
    verified: true, tickTimingVerified: true, evidence: "Builder indicator output capture",
    bbVectors: [bbOne, bbTwo].map((quotes) => ({ quotes, ...bollingerAt(quotes, 19) })),
    rsiVectors: [rsiOne, rsiTwo].map((quotes) =>
      ({ quotes, rsi: rsiAt(quotes, quotes.length - 1) })) };
  assert.equal(verifyPlatformParity(proof, "a".repeat(64)).verified, true);
  assert.throws(() => verifyPlatformParity({ ...proof, tickTimingVerified: false }, "a".repeat(64)),
    /parity has not been verified/);
  assert.throws(() => verifyPlatformParity({ ...proof,
    bbVectors: [{ ...proof.bbVectors[0], upper: proof.bbVectors[0].upper + 1 },
      proof.bbVectors[1]] }, "a".repeat(64)), /BB calculation differs/);
  assert.throws(() => verifyPlatformParity(proof, "b".repeat(64)), /parity has not been verified/);
});

test("forward window guard refuses an early UTC timestamp and accepts only closure", () => {
  const end = Date.parse("2026-10-21T15:47:00Z") / 1_000;
  assert.throws(() => assertForwardWindowClosed(end, Date.parse("2026-10-21T15:46:59Z")),
    /window has not closed/);
  assert.doesNotThrow(() => assertForwardWindowClosed(end, Date.parse("2026-10-21T15:47:00Z")));
});
