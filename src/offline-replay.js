import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadExactArchivedWindow } from "./historical-study.js";

export const REPLAY_WINDOW = Object.freeze({
  symbol: "1HZ100V",
  fromEpoch: 1_788_667_200,
  toEpochExclusive: 1_791_259_200,
  expectedTicks: 2_592_000,
});

// Each rule can be represented with the SMA, comparison, purchase and tick-duration
// blocks already used by the saved Bot Builder XML. These are fixed in advance;
// this module does not search additional parameters after viewing results.
export const REPLAY_CANDIDATES = Object.freeze([
  Object.freeze({ id: "sma-10-20-rise-1t", fastWindow: 10, slowWindow: 20, direction: "rise", horizonTicks: 1 }),
  Object.freeze({ id: "sma-10-20-fall-1t", fastWindow: 10, slowWindow: 20, direction: "fall", horizonTicks: 1 }),
  Object.freeze({ id: "sma-20-50-rise-5t", fastWindow: 20, slowWindow: 50, direction: "rise", horizonTicks: 5 }),
  Object.freeze({ id: "sma-20-50-fall-5t", fastWindow: 20, slowWindow: 50, direction: "fall", horizonTicks: 5 }),
]);
export const REPLAY_ENTRY_DELAYS = Object.freeze([1, 2, 3]);
export const REPLAY_WIN_PAYOUTS = Object.freeze([0.7, 0.8, 0.9]);
export const REPLAY_CRITERION = Object.freeze({
  minimumTradesPerMiddleAndLateSegment: 250,
  baseWinPayout: 0.9,
  stressWinPayout: 0.8,
  minimumBaseAverageProfit: 0,
  minimumLateStressAverageProfit: 0,
  requiredDelays: REPLAY_ENTRY_DELAYS,
});

function assertCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    !Number.isSafeInteger(candidate.fastWindow) ||
    !Number.isSafeInteger(candidate.slowWindow) ||
    !Number.isSafeInteger(candidate.horizonTicks) ||
    candidate.fastWindow < 1 ||
    candidate.fastWindow >= candidate.slowWindow ||
    candidate.horizonTicks < 1 ||
    !["rise", "fall"].includes(candidate.direction)
  ) {
    throw new Error("Invalid bounded SMA replay candidate.");
  }
}

function assertWindow(ticks, fromEpoch, toEpochExclusive) {
  if (
    !Number.isSafeInteger(fromEpoch) ||
    !Number.isSafeInteger(toEpochExclusive) ||
    toEpochExclusive <= fromEpoch ||
    ticks.length !== toEpochExclusive - fromEpoch
  ) {
    throw new Error("Offline replay requires a complete exact one-second window.");
  }
  for (let index = 0; index < ticks.length; index += 1) {
    if (
      ticks[index].epoch !== fromEpoch + index ||
      !Number.isFinite(ticks[index].quote)
    ) {
      throw new Error(`Offline replay has a missing or invalid tick at index ${index}.`);
    }
  }
}

export function buildReplayPricePrefix(ticks) {
  const prefix = new Float64Array(ticks.length + 1);
  for (let index = 0; index < ticks.length; index += 1) {
    prefix[index + 1] = prefix[index] + ticks[index].quote;
  }
  return prefix;
}

function replaySegment(ticks, prefix, candidate, start, endExclusive, delayTicks, captureTrades) {
  const summary = {
    evaluatedSignals: 0,
    noSignalTicks: 0,
    settledTrades: 0,
    wins: 0,
    losses: 0,
    ties: 0,
  };
  if (captureTrades) summary.trades = [];

  // Lookback may precede the segment, but the decision, delayed entry and
  // settlement must all be inside it. After settlement, the next decision is
  // strictly later, so there is never more than one open contract.
  let index = Math.max(start, candidate.slowWindow - 1);
  while (index + delayTicks + candidate.horizonTicks < endExclusive) {
    const fast =
      (prefix[index + 1] - prefix[index + 1 - candidate.fastWindow]) /
      candidate.fastWindow;
    const slow =
      (prefix[index + 1] - prefix[index + 1 - candidate.slowWindow]) /
      candidate.slowWindow;
    const qualifies = candidate.direction === "rise" ? fast > slow : fast < slow;
    summary.evaluatedSignals += 1;
    if (!qualifies) {
      summary.noSignalTicks += 1;
      index += 1;
      continue;
    }

    const entryIndex = index + delayTicks;
    const settlementIndex = entryIndex + candidate.horizonTicks;
    const entryQuote = ticks[entryIndex].quote;
    const settlementQuote = ticks[settlementIndex].quote;
    const tie = settlementQuote === entryQuote;
    const won = candidate.direction === "rise"
      ? settlementQuote > entryQuote
      : settlementQuote < entryQuote;
    summary.settledTrades += 1;
    if (won) summary.wins += 1;
    else summary.losses += 1;
    if (tie) summary.ties += 1;
    if (captureTrades) {
      if (summary.trades.length >= 10_000) {
        throw new Error("Test trace is limited to 10,000 trades.");
      }
      summary.trades.push({ signalIndex: index, entryIndex, settlementIndex, won, tie });
    }
    index = settlementIndex + 1;
  }
  return summary;
}

export function replayCandidateSegment({
  ticks,
  candidate,
  start = 0,
  endExclusive = ticks.length,
  delayTicks = 1,
  captureTrades = false,
  prefix = null,
}) {
  assertCandidate(candidate);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    !Number.isSafeInteger(delayTicks) ||
    start < 0 ||
    endExclusive > ticks.length ||
    endExclusive <= start ||
    delayTicks < 1
  ) {
    throw new Error("Invalid offline replay segment or entry delay.");
  }
  if (prefix !== null && prefix.length !== ticks.length + 1) {
    throw new Error("Replay price prefix does not match the tick window.");
  }
  return replaySegment(
    ticks,
    prefix ?? buildReplayPricePrefix(ticks),
    candidate,
    start,
    endExclusive,
    delayTicks,
    captureTrades,
  );
}

export function scoreReplayCounts(counts, payoutOnWin, payoutOnLoss = -1) {
  if (
    !Number.isFinite(payoutOnWin) ||
    payoutOnWin <= 0 ||
    !Number.isFinite(payoutOnLoss) ||
    payoutOnLoss >= 0
  ) {
    throw new Error("Replay payouts must have positive win and negative loss values.");
  }
  const netProfitPerDollarStake =
    counts.wins * payoutOnWin + counts.losses * payoutOnLoss;
  return {
    ...counts,
    payoutOnWin,
    payoutOnLoss,
    breakEvenWinRate: -payoutOnLoss / (payoutOnWin - payoutOnLoss),
    winRate: counts.settledTrades ? counts.wins / counts.settledTrades : null,
    netProfitPerDollarStake,
    averageProfitPerDollarStake: counts.settledTrades
      ? netProfitPerDollarStake / counts.settledTrades
      : null,
  };
}

function candidateDecision(candidate, ledger) {
  const failures = [];
  let robustnessScore = Infinity;
  for (const delayTicks of REPLAY_ENTRY_DELAYS) {
    const base = ledger.find((row) =>
      row.candidateId === candidate.id &&
      row.delayTicks === delayTicks &&
      row.payoutOnWin === REPLAY_CRITERION.baseWinPayout
    );
    const stress = ledger.find((row) =>
      row.candidateId === candidate.id &&
      row.delayTicks === delayTicks &&
      row.payoutOnWin === REPLAY_CRITERION.stressWinPayout
    );
    for (const segment of ["middle", "late"]) {
      if (base[segment].settledTrades < REPLAY_CRITERION.minimumTradesPerMiddleAndLateSegment) {
        failures.push(`delay=${delayTicks}:${segment}:too_few_trades`);
      }
      if (
        base[segment].averageProfitPerDollarStake === null ||
        base[segment].averageProfitPerDollarStake <= REPLAY_CRITERION.minimumBaseAverageProfit
      ) {
        failures.push(`delay=${delayTicks}:${segment}:base_nonpositive`);
      }
    }
    if (
      stress.late.averageProfitPerDollarStake === null ||
      stress.late.averageProfitPerDollarStake <= REPLAY_CRITERION.minimumLateStressAverageProfit
    ) {
      failures.push(`delay=${delayTicks}:late:stress_nonpositive`);
    }
    robustnessScore = Math.min(
      robustnessScore,
      base.middle.averageProfitPerDollarStake ?? -Infinity,
      base.late.averageProfitPerDollarStake ?? -Infinity,
      stress.late.averageProfitPerDollarStake ?? -Infinity,
    );
  }
  return {
    candidateId: candidate.id,
    passesExploratoryScreen: failures.length === 0,
    robustnessScore: Number.isFinite(robustnessScore) ? robustnessScore : null,
    failures,
  };
}

export function screenReplayLedger(ledger) {
  const candidateScreen = REPLAY_CANDIDATES.map((candidate) =>
    candidateDecision(candidate, ledger)
  );
  const passing = candidateScreen
    .filter((result) => result.passesExploratoryScreen)
    .sort((left, right) =>
      right.robustnessScore - left.robustnessScore ||
      left.candidateId.localeCompare(right.candidateId)
    );
  return {
    criterion: REPLAY_CRITERION,
    candidateResults: candidateScreen,
    decision: passing.length ? "FORWARD_VALIDATION_REQUIRED" : "NO_TRADE",
    candidateId: passing[0]?.candidateId ?? null,
    botBuilderRunPermission: false,
  };
}

export function createOfflineReplayReport({
  ticks,
  symbol,
  fromEpoch,
  toEpochExclusive,
  archive,
  generatedAt = new Date().toISOString(),
}) {
  assertWindow(ticks, fromEpoch, toEpochExclusive);
  if (symbol !== REPLAY_WINDOW.symbol || !/^[a-f0-9]{64}$/.test(archive?.manifestSha256 ?? "")) {
    throw new Error("Offline replay requires the expected symbol and a checksummed manifest.");
  }
  if (ticks.length < 1_000) {
    throw new Error("Offline replay window is too short for bounded segment evaluation.");
  }

  const boundaries = {
    early: [0, Math.floor(ticks.length * 0.7)],
    middle: [Math.floor(ticks.length * 0.7), Math.floor(ticks.length * 0.85)],
    late: [Math.floor(ticks.length * 0.85), ticks.length],
  };
  const prefix = buildReplayPricePrefix(ticks);
  const ledger = [];
  for (const candidate of REPLAY_CANDIDATES) {
    for (const delayTicks of REPLAY_ENTRY_DELAYS) {
      const counts = Object.fromEntries(
        Object.entries(boundaries).map(([name, [start, endExclusive]]) => [
          name,
          replaySegment(ticks, prefix, candidate, start, endExclusive, delayTicks, false),
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

  return {
    kind: "offline-bot-builder-replay",
    generatedAt,
    mode: "research-only",
    archive: {
      ...archive,
      verifiedBy: "loadExactArchivedWindow checksum, quote-conflict and exact-second checks",
    },
    window: {
      symbol,
      fromEpoch,
      toEpochExclusive,
      fromUtc: new Date(fromEpoch * 1_000).toISOString(),
      toUtcExclusive: new Date(toEpochExclusive * 1_000).toISOString(),
      expectedTicks: toEpochExclusive - fromEpoch,
      observedTicks: ticks.length,
    },
    split: {
      method: "Chronological 70/15/15; all segments are viewed development evidence, not a pristine holdout",
      boundaryRule: "SMA lookback may precede a segment; decision, delayed entry and settlement must remain in that segment.",
      early: { fromEpoch, toEpochExclusive: fromEpoch + boundaries.early[1] },
      middle: {
        fromEpoch: fromEpoch + boundaries.middle[0],
        toEpochExclusive: fromEpoch + boundaries.middle[1],
      },
      late: {
        fromEpoch: fromEpoch + boundaries.late[0],
        toEpochExclusive,
      },
    },
    model: {
      candidates: REPLAY_CANDIDATES,
      delaysTicks: REPLAY_ENTRY_DELAYS,
      payoutOnWins: REPLAY_WIN_PAYOUTS,
      payoutOnLoss: -1,
      tieRule: "loss",
      concurrency: "At most one open contract; next signal is considered only after settlement.",
      entryTiming: "Signal on current tick; entry after 1, 2 or 3 observed ticks as processing-delay scenarios.",
      candidateScenariosExpected:
        REPLAY_CANDIDATES.length * REPLAY_ENTRY_DELAYS.length * REPLAY_WIN_PAYOUTS.length,
    },
    candidateScenarioLedger: ledger,
    exploratoryScreen: screenReplayLedger(ledger),
    limitations: [
      "The prior two-week results and this 30-day archive have been viewed; none of these segments is a pristine holdout.",
      "Historical tick prices are not executable contract quotes. Server processing delay and payout are scenarios, not observed historical fills.",
      "Sequential replay represents repeated independent one-shot decisions; the saved conditional XML is one-shot and the browser workspace is not the conditional XML.",
      "The screen is for deciding whether to collect new forward evidence, never permission to press Run, use account credentials, or trade.",
    ],
  };
}

export async function runOfflineReplay({
  projectRoot,
  symbol = REPLAY_WINDOW.symbol,
  fromEpoch = REPLAY_WINDOW.fromEpoch,
  toEpochExclusive = REPLAY_WINDOW.toEpochExclusive,
}) {
  if (
    symbol !== REPLAY_WINDOW.symbol ||
    fromEpoch !== REPLAY_WINDOW.fromEpoch ||
    toEpochExclusive !== REPLAY_WINDOW.toEpochExclusive
  ) {
    throw new Error("Offline replay is locked to the predeclared 30-day symbol and window.");
  }
  const { ticks, archive } = await loadExactArchivedWindow({
    projectRoot,
    symbol,
    fromEpoch,
    toEpoch: toEpochExclusive,
  });
  const report = createOfflineReplayReport({
    ticks,
    symbol,
    fromEpoch,
    toEpochExclusive,
    archive,
  });
  const reportsDirectory = path.join(projectRoot, "data", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = path.join(
    reportsDirectory,
    `offline-replay-${symbol}-${fromEpoch}-${toEpochExclusive}-${Date.now()}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
