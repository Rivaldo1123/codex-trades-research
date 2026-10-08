export const SIGNAL_NONE = 0;
export const SIGNAL_RISE = 1;
export const SIGNAL_FALL = 2;

function validateTiming({ cadenceSeconds, delayTicks, durationTicks }) {
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1) {
    throw new Error("Cadence must be a positive integer number of seconds.");
  }
  if (!Number.isSafeInteger(delayTicks) || delayTicks < 1) {
    throw new Error("Entry delay must be at least one tick.");
  }
  if (!Number.isSafeInteger(durationTicks) || durationTicks < 1) {
    throw new Error("Contract duration must be at least one tick.");
  }
}

export function splitContiguousTicks(ticks, cadenceSeconds = 1) {
  if (!Array.isArray(ticks) || ticks.length === 0) {
    throw new Error("At least one historical tick is required.");
  }
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1) {
    throw new Error("Cadence must be a positive integer number of seconds.");
  }
  const runs = [];
  const gaps = [];
  let start = 0;
  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (
      !Number.isSafeInteger(tick?.epoch) ||
      !Number.isFinite(tick?.quote)
    ) {
      throw new Error("Historical ticks must have finite quotes and integer epochs.");
    }
    if (index === 0) continue;
    const delta = tick.epoch - ticks[index - 1].epoch;
    if (delta <= 0) {
      throw new Error("Historical ticks contain a duplicate or out-of-order epoch.");
    }
    if (delta !== cadenceSeconds) {
      runs.push({ start, endExclusive: index });
      gaps.push({
        afterEpoch: ticks[index - 1].epoch,
        beforeEpoch: tick.epoch,
        missingCadenceSlots: Math.max(0, Math.ceil(delta / cadenceSeconds) - 1),
      });
      start = index;
    }
  }
  runs.push({ start, endExclusive: ticks.length });
  return { gaps, runs };
}

export function deriveSmaSignals({
  ticks,
  fastWindow,
  slowWindow,
  direction,
  cadenceSeconds = 1,
  resetEpochs = [],
}) {
  if (
    !Number.isInteger(fastWindow) ||
    !Number.isInteger(slowWindow) ||
    fastWindow < 1 ||
    slowWindow <= fastWindow
  ) {
    throw new Error("SMA windows must be positive with fastWindow < slowWindow.");
  }
  if (!["rise", "fall", "both"].includes(direction)) {
    throw new Error('SMA direction must be "rise", "fall", or "both".');
  }
  const { runs, gaps } = splitContiguousTicks(ticks, cadenceSeconds);
  const boundaries = [...new Set(resetEpochs)]
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  const signals = new Uint8Array(ticks.length);
  const effectiveRuns = [];
  for (const run of runs) {
    let cursor = run.start;
    for (const boundary of boundaries) {
      if (
        boundary > ticks[cursor].epoch &&
        boundary <= ticks[run.endExclusive - 1].epoch
      ) {
        let split = cursor;
        while (split < run.endExclusive && ticks[split].epoch < boundary) split += 1;
        if (split > cursor) effectiveRuns.push({ start: cursor, endExclusive: split });
        cursor = split;
      }
    }
    if (cursor < run.endExclusive) {
      effectiveRuns.push({ start: cursor, endExclusive: run.endExclusive });
    }
  }
  for (const run of effectiveRuns) {
    const prefix = new Float64Array(run.endExclusive - run.start + 1);
    for (let local = 0; local < run.endExclusive - run.start; local += 1) {
      prefix[local + 1] = prefix[local] + ticks[run.start + local].quote;
      if (local + 1 < slowWindow) continue;
      const fast =
        (prefix[local + 1] - prefix[local + 1 - fastWindow]) / fastWindow;
      const slow =
        (prefix[local + 1] - prefix[local + 1 - slowWindow]) / slowWindow;
      const index = run.start + local;
      if (direction === "rise") signals[index] = fast > slow ? SIGNAL_RISE : SIGNAL_NONE;
      else if (direction === "fall") signals[index] = fast < slow ? SIGNAL_FALL : SIGNAL_NONE;
      else signals[index] = fast > slow ? SIGNAL_RISE : fast < slow ? SIGNAL_FALL : SIGNAL_NONE;
    }
  }
  return { effectiveRuns, gaps, signals };
}

function emptyCounts() {
  return {
    evaluatedDecisionTicks: 0,
    losses: 0,
    noSignalTicks: 0,
    settledTrades: 0,
    ties: 0,
    wins: 0,
  };
}

export function replaySequentialSignals({
  ticks,
  signals,
  fromEpoch,
  toEpochExclusive,
  delayTicks,
  durationTicks,
  cadenceSeconds = 1,
  captureTrades = false,
}) {
  validateTiming({ cadenceSeconds, delayTicks, durationTicks });
  if (
    !(signals instanceof Uint8Array) ||
    signals.length !== ticks.length ||
    !Number.isSafeInteger(fromEpoch) ||
    !Number.isSafeInteger(toEpochExclusive) ||
    toEpochExclusive <= fromEpoch
  ) {
    throw new Error("Sequential replay dimensions or epoch boundaries are invalid.");
  }
  const { runs, gaps } = splitContiguousTicks(ticks, cadenceSeconds);
  const counts = emptyCounts();
  const trades = captureTrades ? [] : null;
  for (const run of runs) {
    let index = run.start;
    while (index < run.endExclusive && ticks[index].epoch < fromEpoch) index += 1;
    while (index < run.endExclusive && ticks[index].epoch < toEpochExclusive) {
      counts.evaluatedDecisionTicks += 1;
      const direction = signals[index];
      if (direction !== SIGNAL_RISE && direction !== SIGNAL_FALL) {
        counts.noSignalTicks += 1;
        index += 1;
        continue;
      }
      const entryIndex = index + delayTicks;
      const settlementIndex = entryIndex + durationTicks;
      if (
        settlementIndex >= run.endExclusive ||
        ticks[entryIndex].epoch >= toEpochExclusive ||
        ticks[settlementIndex].epoch >= toEpochExclusive
      ) {
        index += 1;
        continue;
      }
      const entry = ticks[entryIndex].quote;
      const exit = ticks[settlementIndex].quote;
      const won =
        direction === SIGNAL_RISE ? exit > entry : exit < entry;
      const tie = exit === entry;
      counts.settledTrades += 1;
      if (won) counts.wins += 1;
      else counts.losses += 1;
      if (tie) counts.ties += 1;
      if (trades) {
        trades.push({
          direction: direction === SIGNAL_RISE ? "rise" : "fall",
          entryEpoch: ticks[entryIndex].epoch,
          entryQuote: entry,
          settlementEpoch: ticks[settlementIndex].epoch,
          settlementQuote: exit,
          signalEpoch: ticks[index].epoch,
          tie,
          won,
        });
      }
      // Exactly one contract may be open. Decisions during its lifetime are
      // not retrospectively queued after settlement.
      index = settlementIndex + 1;
    }
  }
  return { counts, gaps, ...(trades ? { trades } : {}) };
}

export function scoreBinaryCounts(
  counts,
  { payoutOnWin, payoutOnLoss = -1 } = {},
) {
  if (
    !Number.isFinite(payoutOnWin) ||
    payoutOnWin <= 0 ||
    !Number.isFinite(payoutOnLoss) ||
    payoutOnLoss >= 0
  ) {
    throw new Error("Binary contract payout assumptions are invalid.");
  }
  const netProfit =
    counts.wins * payoutOnWin + counts.losses * payoutOnLoss;
  return {
    ...counts,
    averageProfitPerDollarStake:
      counts.settledTrades === 0 ? null : netProfit / counts.settledTrades,
    netProfitPerDollarStake: netProfit,
    payoutOnLoss,
    payoutOnWin,
    profitFactor:
      counts.losses === 0
        ? null
        : (counts.wins * payoutOnWin) /
          (-counts.losses * payoutOnLoss),
    winRate:
      counts.settledTrades === 0 ? null : counts.wins / counts.settledTrades,
  };
}
