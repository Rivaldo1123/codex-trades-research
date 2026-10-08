import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendTickChunk } from "../src/data-store.js";
import {
  createGapAwareOfflineReplayReport,
  findMissingRanges,
  loadGapAwareArchivedWindow,
  replayGapAwareCandidateSegment,
} from "../src/offline-replay-gap.js";
import { REPLAY_CANDIDATES, REPLAY_ENTRY_DELAYS, REPLAY_WIN_PAYOUTS } from "../src/offline-replay.js";

const fromEpoch = 1_700_000_000;
const toEpochExclusive = fromEpoch + 1_200;
const sourceGap = {
  fromEpoch: fromEpoch + 500,
  toEpochExclusive: fromEpoch + 507,
  missingTicks: 7,
};
const expectedMissingRanges = [sourceGap];
const archive = { manifestSha256: "a".repeat(64), selectedChunks: 1 };

function genuineTicks() {
  return Array.from({ length: 1_200 }, (_, index) => ({
    epoch: fromEpoch + index,
    quote: 100 + index,
  })).filter((tick) =>
    tick.epoch < sourceGap.fromEpoch || tick.epoch >= sourceGap.toEpochExclusive
  );
}

test("gap detector reports exactly the seven missing source seconds", () => {
  assert.deepEqual(findMissingRanges(genuineTicks(), fromEpoch, toEpochExclusive), expectedMissingRanges);
  assert.throws(() => findMissingRanges(
    [...genuineTicks(), genuineTicks().at(-1)], fromEpoch, toEpochExclusive,
  ), /duplicate or out-of-order/);
});

test("SMA warm-up and contracts never cross the missing interval", () => {
  const candidate = REPLAY_CANDIDATES[0];
  const replay = replayGapAwareCandidateSegment({
    ticks: genuineTicks(),
    candidate,
    fromEpoch,
    toEpochExclusive,
    delayTicks: 1,
    captureTrades: true,
  });
  assert.ok(replay.trades.length > 0);
  for (const trade of replay.trades) {
    assert.ok(
      trade.settlementEpoch < sourceGap.fromEpoch ||
      trade.signalEpoch >= sourceGap.toEpochExclusive + candidate.slowWindow - 1,
    );
    assert.ok(trade.signalEpoch < trade.entryEpoch && trade.entryEpoch < trade.settlementEpoch);
  }
  for (let index = 1; index < replay.trades.length; index += 1) {
    assert.ok(replay.trades[index].signalEpoch > replay.trades[index - 1].settlementEpoch);
  }
});

test("gap-aware report uses UTC split boundaries, records exclusions, and stays disarmed", () => {
  const report = createGapAwareOfflineReplayReport({
    ticks: genuineTicks(),
    symbol: "1HZ100V",
    fromEpoch,
    toEpochExclusive,
    archive,
    expectedMissingRanges,
    generatedAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(report.window.expectedTicks, 1_200);
  assert.equal(report.window.observedGenuineTicks, 1_193);
  assert.equal(report.window.missingTicks, 7);
  assert.equal(report.window.archiveComplete, false);
  assert.equal(report.split.early.toEpochExclusive, fromEpoch + 840);
  assert.equal(report.split.middle.fromEpoch, fromEpoch + 840);
  assert.equal(report.split.late.fromEpoch, fromEpoch + 1_020);
  assert.equal(report.split.early.observedGenuineTicks, 833);
  assert.equal(report.split.middle.observedGenuineTicks, 180);
  assert.equal(report.split.late.observedGenuineTicks, 180);
  assert.equal(report.missingRanges.length, 1);
  assert.equal(report.excludedSignalWindows.length,
    REPLAY_CANDIDATES.length * REPLAY_ENTRY_DELAYS.length);
  const exclusion = report.excludedSignalWindows.find((item) =>
    item.candidateId === "sma-10-20-rise-1t" && item.delayTicks === 1
  );
  assert.equal(exclusion.fromSignalEpoch, fromEpoch + 498);
  assert.equal(exclusion.toSignalEpochExclusive, fromEpoch + 526);
  assert.equal(report.candidateScenarioLedger.length,
    REPLAY_CANDIDATES.length * REPLAY_ENTRY_DELAYS.length * REPLAY_WIN_PAYOUTS.length);
  assert.equal(report.exploratoryScreen.decision, "NO_TRADE");
  assert.equal(report.exploratoryScreen.botBuilderRunPermission, false);
  assert.match(report.split.method, /not a pristine holdout/);
});

test("gap-aware report fails closed for another missing tick or a fabricated fill", () => {
  const ticks = genuineTicks();
  const anotherGap = ticks.filter((tick) => tick.epoch !== fromEpoch + 900);
  const filledGap = [...ticks, { epoch: sourceGap.fromEpoch, quote: 1_000 }]
    .sort((left, right) => left.epoch - right.epoch);
  const base = {
    symbol: "1HZ100V", fromEpoch, toEpochExclusive, archive, expectedMissingRanges,
  };
  assert.throws(() => createGapAwareOfflineReplayReport({ ...base, ticks: anotherGap }),
    /exactly the predeclared missing source range/);
  assert.throws(() => createGapAwareOfflineReplayReport({ ...base, ticks: filledGap }),
    /exactly the predeclared missing source range/);
});

test("gap-aware archive loader verifies chunk hashes and exact known gap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "offline-gap-replay-"));
  try {
    const { chunk } = await appendTickChunk(root, "1HZ100V", genuineTicks());
    const input = {
      projectRoot: root,
      symbol: "1HZ100V",
      fromEpoch,
      toEpochExclusive,
      expectedMissingRanges,
    };
    const loaded = await loadGapAwareArchivedWindow(input);
    assert.equal(loaded.ticks.length, 1_193);
    assert.deepEqual(loaded.missingRanges, expectedMissingRanges);
    assert.match(loaded.archive.manifestSha256, /^[a-f0-9]{64}$/);

    const chunkPath = path.join(root, "data", "market", "1HZ100V", chunk.file);
    const bytes = await readFile(chunkPath);
    bytes[0] ^= 1;
    await writeFile(chunkPath, bytes);
    await assert.rejects(loadGapAwareArchivedWindow(input), /checksum failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
