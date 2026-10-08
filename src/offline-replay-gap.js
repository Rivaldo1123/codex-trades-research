import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { symbolDataDirectory } from "./data-store.js";
import {
  REPLAY_CANDIDATES,
  REPLAY_ENTRY_DELAYS,
  REPLAY_WIN_PAYOUTS,
  REPLAY_WINDOW,
  buildReplayPricePrefix,
  replayCandidateSegment,
  scoreReplayCounts,
  screenReplayLedger,
} from "./offline-replay.js";

export const SOURCE_MISSING_RANGE = Object.freeze({
  fromEpoch: 1_789_085_201,
  toEpochExclusive: 1_789_085_208,
  missingTicks: 7,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameRanges(actual, expected) {
  return actual.length === expected.length && actual.every((range, index) =>
    range.fromEpoch === expected[index].fromEpoch &&
    range.toEpochExclusive === expected[index].toEpochExclusive &&
    range.missingTicks === expected[index].missingTicks
  );
}

export function findMissingRanges(ticks, fromEpoch, toEpochExclusive) {
  if (
    !Number.isSafeInteger(fromEpoch) ||
    !Number.isSafeInteger(toEpochExclusive) ||
    toEpochExclusive <= fromEpoch
  ) {
    throw new Error("Gap-aware replay requires increasing integer UTC epochs.");
  }
  const gaps = [];
  let expectedEpoch = fromEpoch;
  for (const tick of ticks) {
    if (
      !Number.isSafeInteger(tick.epoch) ||
      !Number.isFinite(tick.quote) ||
      tick.epoch < expectedEpoch ||
      tick.epoch >= toEpochExclusive
    ) {
      throw new Error("Gap-aware replay found an invalid, duplicate or out-of-order archived tick.");
    }
    if (tick.epoch > expectedEpoch) {
      gaps.push({
        fromEpoch: expectedEpoch,
        toEpochExclusive: tick.epoch,
        missingTicks: tick.epoch - expectedEpoch,
      });
    }
    expectedEpoch = tick.epoch + 1;
  }
  if (expectedEpoch < toEpochExclusive) {
    gaps.push({
      fromEpoch: expectedEpoch,
      toEpochExclusive,
      missingTicks: toEpochExclusive - expectedEpoch,
    });
  }
  return gaps;
}

export async function loadGapAwareArchivedWindow({
  projectRoot,
  symbol,
  fromEpoch,
  toEpochExclusive,
  expectedMissingRanges,
}) {
  const directory = symbolDataDirectory(projectRoot, symbol);
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== 1 || manifest.symbol !== symbol || !Array.isArray(manifest.chunks)) {
    throw new Error("Gap-aware replay found an unsupported archive manifest.");
  }
  const selectedChunks = manifest.chunks.filter((chunk) =>
    chunk.lastEpoch >= fromEpoch && chunk.firstEpoch < toEpochExclusive
  );
  const byEpoch = new Map();
  for (const chunk of selectedChunks) {
    const compressed = await readFile(path.join(directory, chunk.file));
    if (sha256(compressed) !== chunk.sha256) {
      throw new Error(`Tick archive checksum failed for ${chunk.file}.`);
    }
    const lines = gunzipSync(compressed).toString("utf8").trimEnd().split("\n");
    if (lines.length !== chunk.rows) {
      throw new Error(`Tick archive row count failed for ${chunk.file}.`);
    }
    let first = Infinity;
    let last = -Infinity;
    for (const line of lines) {
      const tick = JSON.parse(line);
      if (!Number.isSafeInteger(tick.epoch) || !Number.isFinite(tick.quote)) {
        throw new Error(`Invalid archived tick in ${chunk.file}.`);
      }
      first = Math.min(first, tick.epoch);
      last = Math.max(last, tick.epoch);
      if (tick.epoch < fromEpoch || tick.epoch >= toEpochExclusive) continue;
      const previous = byEpoch.get(tick.epoch);
      if (previous !== undefined && previous !== tick.quote) {
        throw new Error(`Archived quote conflict at epoch ${tick.epoch}.`);
      }
      byEpoch.set(tick.epoch, tick.quote);
    }
    if (first !== chunk.firstEpoch || last !== chunk.lastEpoch) {
      throw new Error(`Tick archive epoch bounds failed for ${chunk.file}.`);
    }
  }
  const currentManifestBytes = await readFile(manifestPath);
  if (sha256(currentManifestBytes) !== sha256(manifestBytes)) {
    throw new Error("Tick archive changed during gap-aware replay; retry after collection stops.");
  }
  const ticks = [...byEpoch.entries()]
    .map(([epoch, quote]) => ({ epoch, quote }))
    .sort((left, right) => left.epoch - right.epoch);
  const missingRanges = findMissingRanges(ticks, fromEpoch, toEpochExclusive);
  if (!sameRanges(missingRanges, expectedMissingRanges)) {
    throw new Error("Gap-aware replay refuses any missing range other than the predeclared source gap.");
  }
  return {
    ticks,
    missingRanges,
    archive: {
      manifestSha256: sha256(manifestBytes),
      manifestUpdatedAt: manifest.updatedAt ?? null,
      selectedChunks: selectedChunks.length,
      verification: "Each selected chunk SHA-256, row count, epoch bounds and quote conflicts checked; manifest stable during read.",
    },
  };
}

function contiguousRuns(ticks) {
  const runs = [];
  let start = 0;
  for (let index = 1; index <= ticks.length; index += 1) {
    if (index < ticks.length && ticks[index].epoch === ticks[index - 1].epoch + 1) continue;
    const runTicks = ticks.slice(start, index);
    runs.push({
      firstEpoch: runTicks[0].epoch,
      lastEpoch: runTicks.at(-1).epoch,
      ticks: runTicks,
      prefix: buildReplayPricePrefix(runTicks),
    });
    start = index;
  }
  return runs;
}

function zeroCounts(captureTrades) {
  const result = {
    evaluatedSignals: 0,
    noSignalTicks: 0,
    settledTrades: 0,
    wins: 0,
    losses: 0,
    ties: 0,
  };
  if (captureTrades) result.trades = [];
  return result;
}

function replayRunsInEpochSegment(runs, candidate, fromEpoch, toEpochExclusive, delayTicks, captureTrades) {
  const total = zeroCounts(captureTrades);
  for (const run of runs) {
    const overlapFrom = Math.max(fromEpoch, run.firstEpoch);
    const overlapTo = Math.min(toEpochExclusive, run.lastEpoch + 1);
    if (overlapFrom >= overlapTo) continue;
    const counts = replayCandidateSegment({
      ticks: run.ticks,
      prefix: run.prefix,
      candidate,
      start: overlapFrom - run.firstEpoch,
      endExclusive: overlapTo - run.firstEpoch,
      delayTicks,
      captureTrades,
    });
    for (const key of ["evaluatedSignals", "noSignalTicks", "settledTrades", "wins", "losses", "ties"]) {
      total[key] += counts[key];
    }
    if (captureTrades) {
      total.trades.push(...counts.trades.map((trade) => ({
        signalEpoch: run.firstEpoch + trade.signalIndex,
        entryEpoch: run.firstEpoch + trade.entryIndex,
        settlementEpoch: run.firstEpoch + trade.settlementIndex,
        won: trade.won,
        tie: trade.tie,
      })));
    }
  }
  return total;
}

export function replayGapAwareCandidateSegment({
  ticks,
  candidate,
  fromEpoch,
  toEpochExclusive,
  delayTicks = 1,
  captureTrades = false,
}) {
  return replayRunsInEpochSegment(
    contiguousRuns(ticks), candidate, fromEpoch, toEpochExclusive, delayTicks, captureTrades,
  );
}

function observedInRange(ticks, fromEpoch, toEpochExclusive) {
  let count = 0;
  for (const tick of ticks) {
    if (tick.epoch >= fromEpoch && tick.epoch < toEpochExclusive) count += 1;
  }
  return count;
}

export function createGapAwareOfflineReplayReport({
  ticks,
  symbol,
  fromEpoch,
  toEpochExclusive,
  archive,
  expectedMissingRanges,
  generatedAt = new Date().toISOString(),
}) {
  if (symbol !== REPLAY_WINDOW.symbol || !/^[a-f0-9]{64}$/.test(archive?.manifestSha256 ?? "")) {
    throw new Error("Gap-aware replay requires the expected symbol and a checksummed manifest.");
  }
  const missingRanges = findMissingRanges(ticks, fromEpoch, toEpochExclusive);
  if (!sameRanges(missingRanges, expectedMissingRanges) || missingRanges.length === 0) {
    throw new Error("Gap-aware replay requires exactly the predeclared missing source range.");
  }
  if (ticks.length !== toEpochExclusive - fromEpoch -
      expectedMissingRanges.reduce((sum, gap) => sum + gap.missingTicks, 0)) {
    throw new Error("Gap-aware replay row count does not match the predeclared source gap.");
  }
  if (ticks.length < 1_000) {
    throw new Error("Gap-aware replay window is too short for bounded segment evaluation.");
  }

  // Boundaries use actual UTC seconds, never row counts. The seven absent ticks
  // therefore cannot move a chronological split or masquerade as observations.
  const firstBoundary = fromEpoch + Math.floor((toEpochExclusive - fromEpoch) * 0.7);
  const secondBoundary = fromEpoch + Math.floor((toEpochExclusive - fromEpoch) * 0.85);
  const segmentBounds = {
    early: [fromEpoch, firstBoundary],
    middle: [firstBoundary, secondBoundary],
    late: [secondBoundary, toEpochExclusive],
  };
  const runs = contiguousRuns(ticks);
  const ledger = [];
  for (const candidate of REPLAY_CANDIDATES) {
    for (const delayTicks of REPLAY_ENTRY_DELAYS) {
      const counts = Object.fromEntries(
        Object.entries(segmentBounds).map(([name, [start, end]]) => [
          name,
          replayRunsInEpochSegment(runs, candidate, start, end, delayTicks, false),
        ]),
      );
      for (const payoutOnWin of REPLAY_WIN_PAYOUTS) {
        ledger.push({
          scenarioId: `${candidate.id}|delay=${delayTicks}|win=${payoutOnWin.toFixed(2)}`,
          candidateId: candidate.id,
          delayTicks,
          payoutOnWin,
          payoutOnLoss: -1,
          early: scoreReplayCounts(counts.early, payoutOnWin),
          middle: scoreReplayCounts(counts.middle, payoutOnWin),
          late: scoreReplayCounts(counts.late, payoutOnWin),
        });
      }
    }
  }
  const excludedWindows = missingRanges.flatMap((gap) =>
    REPLAY_CANDIDATES.flatMap((candidate) =>
      REPLAY_ENTRY_DELAYS.map((delayTicks) => {
        const excludedFrom = Math.max(
          fromEpoch, gap.fromEpoch - delayTicks - candidate.horizonTicks,
        );
        const excludedTo = Math.min(
          toEpochExclusive, gap.toEpochExclusive + candidate.slowWindow - 1,
        );
        return {
          candidateId: candidate.id,
          delayTicks,
          fromSignalEpoch: excludedFrom,
          toSignalEpochExclusive: excludedTo,
          fromUtc: new Date(excludedFrom * 1_000).toISOString(),
          toUtcExclusive: new Date(excludedTo * 1_000).toISOString(),
          reason: "SMA lookback may include a missing tick, or delayed entry/settlement may cross it.",
        };
      })
    )
  );
  return {
    kind: "offline-bot-builder-gap-aware-replay",
    generatedAt,
    mode: "exploratory-development-only",
    archive,
    window: {
      symbol,
      fromEpoch,
      toEpochExclusive,
      fromUtc: new Date(fromEpoch * 1_000).toISOString(),
      toUtcExclusive: new Date(toEpochExclusive * 1_000).toISOString(),
      expectedTicks: toEpochExclusive - fromEpoch,
      observedGenuineTicks: ticks.length,
      missingTicks: missingRanges.reduce((sum, gap) => sum + gap.missingTicks, 0),
      archiveComplete: false,
    },
    missingRanges: missingRanges.map((gap) => ({
      ...gap,
      fromUtc: new Date(gap.fromEpoch * 1_000).toISOString(),
      toUtcExclusive: new Date(gap.toEpochExclusive * 1_000).toISOString(),
    })),
    excludedSignalWindows: excludedWindows,
    split: {
      method: "Chronological 70/15/15 by UTC epoch; all segments are viewed development evidence, not a pristine holdout",
      boundaryRule: "SMA resets after each gap. No signal, delayed entry or settlement may cross a gap or a scored segment boundary.",
      ...Object.fromEntries(
        Object.entries(segmentBounds).map(([name, [start, end]]) => [
          name,
          { fromEpoch: start, toEpochExclusive: end, observedGenuineTicks: observedInRange(ticks, start, end) },
        ]),
      ),
    },
    model: {
      candidates: REPLAY_CANDIDATES,
      delaysTicks: REPLAY_ENTRY_DELAYS,
      payoutOnWins: REPLAY_WIN_PAYOUTS,
      payoutOnLoss: -1,
      tieRule: "loss",
      concurrency: "At most one open contract; next signal is considered only after settlement.",
      candidateScenariosExpected:
        REPLAY_CANDIDATES.length * REPLAY_ENTRY_DELAYS.length * REPLAY_WIN_PAYOUTS.length,
    },
    candidateScenarioLedger: ledger,
    exploratoryScreen: screenReplayLedger(ledger),
    limitations: [
      "Seven seconds are absent from Deriv's public history and remain absent from the archive; no prices were fabricated or interpolated.",
      "The archive is INCOMPLETE. This gap-aware replay cannot satisfy the exact-window gate or enable Bot Builder Run.",
      "The prior two-week results and this 30-day archive have been viewed; none of these segments is a pristine holdout.",
      "Historical prices are not executable contract quotes; server-processing delays and payouts are sensitivity assumptions.",
      "Sequential replay models repeated independent one-shot decisions; the saved conditional XML is one-shot and the browser workspace differs from it.",
    ],
  };
}

export async function runGapAwareOfflineReplay({ projectRoot }) {
  const { symbol, fromEpoch, toEpochExclusive, expectedTicks } = REPLAY_WINDOW;
  const expectedMissingRanges = [SOURCE_MISSING_RANGE];
  const { ticks, archive } = await loadGapAwareArchivedWindow({
    projectRoot, symbol, fromEpoch, toEpochExclusive, expectedMissingRanges,
  });
  if (ticks.length !== expectedTicks - SOURCE_MISSING_RANGE.missingTicks) {
    throw new Error("Gap-aware replay requires the exact known 2,591,993 genuine-row archive.");
  }
  const report = createGapAwareOfflineReplayReport({
    ticks, symbol, fromEpoch, toEpochExclusive, archive, expectedMissingRanges,
  });
  const reportsDirectory = path.join(projectRoot, "data", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = path.join(
    reportsDirectory,
    `offline-gap-replay-${symbol}-${fromEpoch}-${toEpochExclusive}-${Date.now()}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
