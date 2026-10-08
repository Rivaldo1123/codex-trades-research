import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLAY_CANDIDATES,
  REPLAY_ENTRY_DELAYS,
  REPLAY_WIN_PAYOUTS,
  createOfflineReplayReport,
  replayCandidateSegment,
  runOfflineReplay,
  scoreReplayCounts,
} from "../src/offline-replay.js";

const fromEpoch = 1_700_000_000;
const archive = { manifestSha256: "a".repeat(64), selectedChunks: 1 };

function risingTicks(length) {
  return Array.from({ length }, (_, index) => ({
    epoch: fromEpoch + index,
    quote: 100 + index,
  }));
}

function reportFor(ticks) {
  return createOfflineReplayReport({
    ticks,
    symbol: "1HZ100V",
    fromEpoch,
    toEpochExclusive: fromEpoch + ticks.length,
    archive,
    generatedAt: "2026-10-07T00:00:00.000Z",
  });
}

test("a replay never opens a second contract before the first settles", () => {
  const ticks = risingTicks(120);
  const result = replayCandidateSegment({
    ticks,
    candidate: { id: "fixture", fastWindow: 1, slowWindow: 2, horizonTicks: 2, direction: "rise" },
    delayTicks: 1,
    captureTrades: true,
  });
  assert.ok(result.trades.length > 2);
  for (let index = 1; index < result.trades.length; index += 1) {
    assert.ok(result.trades[index].signalIndex > result.trades[index - 1].settlementIndex);
  }
  assert.equal(result.wins, result.settledTrades);
});

test("SMA may warm up from earlier ticks, but decision, entry and settlement stay inside the segment", () => {
  const ticks = risingTicks(200);
  const result = replayCandidateSegment({
    ticks,
    candidate: { id: "fixture", fastWindow: 10, slowWindow: 20, horizonTicks: 5, direction: "rise" },
    start: 100,
    endExclusive: 160,
    delayTicks: 3,
    captureTrades: true,
  });
  assert.equal(result.trades[0].signalIndex, 100);
  assert.ok(result.trades.every((trade) =>
    trade.signalIndex >= 100 &&
    trade.entryIndex >= 100 &&
    trade.settlementIndex < 160
  ));
  assert.equal(result.trades.at(-1).settlementIndex, 153);
});

test("processing delay changes the entry quote and can reverse an outcome", () => {
  const ticks = risingTicks(100);
  ticks[20].quote = 1_000;
  ticks[21].quote = 900;
  ticks[22].quote = 1_100;
  const candidate = {
    id: "fixture",
    fastWindow: 10,
    slowWindow: 20,
    horizonTicks: 1,
    direction: "rise",
  };
  const nextTick = replayCandidateSegment({ ticks, candidate, delayTicks: 1, captureTrades: true });
  const laterTick = replayCandidateSegment({ ticks, candidate, delayTicks: 2, captureTrades: true });
  assert.deepEqual(nextTick.trades[0], {
    signalIndex: 19,
    entryIndex: 20,
    settlementIndex: 21,
    won: false,
    tie: false,
  });
  assert.deepEqual(laterTick.trades[0], {
    signalIndex: 19,
    entryIndex: 21,
    settlementIndex: 22,
    won: true,
    tie: false,
  });
});

test("an unchanged settlement is a loss and payout sensitivity is explicit", () => {
  const ticks = risingTicks(100);
  ticks[20].quote = 1_000;
  ticks[21].quote = 1_000;
  const result = replayCandidateSegment({
    ticks,
    candidate: { id: "fixture", fastWindow: 10, slowWindow: 20, horizonTicks: 1, direction: "rise" },
    delayTicks: 1,
    captureTrades: true,
  });
  assert.equal(result.trades[0].tie, true);
  assert.equal(result.trades[0].won, false);
  assert.ok(result.ties >= 1);
  assert.ok(result.losses >= result.ties);

  const counts = { settledTrades: 10, wins: 5, losses: 5 };
  assert.equal(scoreReplayCounts(counts, 0.9).netProfitPerDollarStake, -0.5);
  assert.equal(scoreReplayCounts(counts, 0.7).netProfitPerDollarStake, -1.5);
  assert.ok(scoreReplayCounts(counts, 0.7).breakEvenWinRate >
    scoreReplayCounts(counts, 0.9).breakEvenWinRate);
});

test("fixed candidate/scenario ledger is exhaustive and deterministic; insufficient sample means NO TRADE", () => {
  const ticks = risingTicks(1_000);
  const first = reportFor(ticks);
  const second = reportFor(ticks);
  assert.deepEqual(first.candidateScenarioLedger, second.candidateScenarioLedger);
  assert.equal(first.candidateScenarioLedger.length,
    REPLAY_CANDIDATES.length * REPLAY_ENTRY_DELAYS.length * REPLAY_WIN_PAYOUTS.length);
  assert.equal(new Set(first.candidateScenarioLedger.map((row) => row.scenarioId)).size,
    first.candidateScenarioLedger.length);
  assert.equal(first.exploratoryScreen.decision, "NO_TRADE");
  assert.equal(first.exploratoryScreen.botBuilderRunPermission, false);
  assert.match(first.split.method, /not a pristine holdout/);
});

test("even a positive exploratory screen never grants Bot Builder Run permission", () => {
  const result = reportFor(risingTicks(10_000));
  assert.equal(result.exploratoryScreen.decision, "FORWARD_VALIDATION_REQUIRED");
  assert.equal(result.exploratoryScreen.botBuilderRunPermission, false);
});

test("exact-window, symbol and manifest checks fail closed", async () => {
  const ticks = risingTicks(1_000);
  const missing = ticks.filter((tick) => tick.epoch !== fromEpoch + 100);
  assert.throws(() => reportFor(missing), /missing or invalid tick/);
  assert.throws(() => createOfflineReplayReport({
    ticks,
    symbol: "OTHER",
    fromEpoch,
    toEpochExclusive: fromEpoch + ticks.length,
    archive,
  }), /expected symbol/);
  assert.throws(() => createOfflineReplayReport({
    ticks,
    symbol: "1HZ100V",
    fromEpoch,
    toEpochExclusive: fromEpoch + ticks.length,
    archive: { manifestSha256: "not-a-checksum" },
  }), /checksummed manifest/);
  await assert.rejects(runOfflineReplay({
    projectRoot: "unused",
    fromEpoch,
    toEpochExclusive: fromEpoch + ticks.length,
  }), /locked to the predeclared 30-day/);
});
