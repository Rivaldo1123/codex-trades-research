import {
  deriveSmaSignals,
  replaySequentialSignals,
  scoreBinaryCounts,
} from "./execution-model.js";

export const BROWSER_FLOW_PARAMETERS = Object.freeze({
  cadenceSeconds: 1,
  entryDelayTicks: 1,
  fastWindow: 10,
  horizonTicks: 1,
  payoutOnLoss: -1,
  payoutOnWin: 0.9,
  slowWindow: 20,
});

function evaluate(ticks, signals, parameters, startEpoch, endEpochExclusive) {
  const replay = replaySequentialSignals({
    cadenceSeconds: parameters.cadenceSeconds,
    delayTicks: parameters.entryDelayTicks,
    durationTicks: parameters.horizonTicks,
    fromEpoch: startEpoch,
    signals,
    ticks,
    toEpochExclusive: endEpochExclusive,
  });
  const scored = scoreBinaryCounts(replay.counts, {
    payoutOnLoss: parameters.payoutOnLoss,
    payoutOnWin: parameters.payoutOnWin,
  });
  return {
    ...scored,
    observations: scored.settledTrades,
    skipped: scored.noSignalTicks,
  };
}

export function runDirectionalSmaFlowBacktest(
  ticks,
  direction,
  parameters = BROWSER_FLOW_PARAMETERS,
) {
  if (direction !== "rise" && direction !== "fall") {
    throw new Error('Browser-flow direction must be "rise" or "fall".');
  }
  const merged = { ...BROWSER_FLOW_PARAMETERS, ...parameters };
  if (
    ticks.length <
    merged.slowWindow + merged.entryDelayTicks + merged.horizonTicks + 100
  ) {
    throw new Error("Not enough ticks for the browser-flow backtest.");
  }
  const firstEpoch = ticks[0].epoch;
  const endEpochExclusive = ticks.at(-1).epoch + merged.cadenceSeconds;
  const span = endEpochExclusive - firstEpoch;
  const trainBoundary = firstEpoch + Math.floor(span * 0.7);
  const validationBoundary = firstEpoch + Math.floor(span * 0.85);
  const { signals, gaps } = deriveSmaSignals({
    cadenceSeconds: merged.cadenceSeconds,
    direction,
    fastWindow: merged.fastWindow,
    resetEpochs: [trainBoundary, validationBoundary],
    slowWindow: merged.slowWindow,
    ticks,
  });
  return {
    generatedAt: new Date().toISOString(),
    flow:
      direction === "rise"
        ? "Buy Rise only when the fast SMA is above the slow SMA; otherwise wait"
        : "Buy Fall only when the fast SMA is below the slow SMA; otherwise wait",
    input: {
      firstEpoch,
      gaps,
      lastEpoch: ticks.at(-1).epoch,
      ticks: ticks.length,
    },
    methodology: {
      entryTiming:
        "The signal uses the current tick. With the default delay, entry uses the following tick; settlement then follows the configured contract duration.",
      execution:
        "Shared gap-aware engine; indicator warm-up resets at gaps and split boundaries; no decision, entry, or settlement crosses a gap; at most one contract is open.",
      payoutModel:
        `Each qualifying $1 contract is scored +$${merged.payoutOnWin.toFixed(2)} on a win and $${merged.payoutOnLoss.toFixed(2)} on a loss or tie. These are assumptions, not historical executable quotes.`,
      selection:
        "This legacy candidate is retained for reproducibility but its browser gate is retired.",
      split:
        "Chronological 70/15/15 by UTC epoch with boundary resets and no cross-segment settlement.",
    },
    parameters: { ...merged, direction },
    training: evaluate(ticks, signals, merged, firstEpoch, trainBoundary),
    validation: evaluate(
      ticks,
      signals,
      merged,
      trainBoundary,
      validationBoundary,
    ),
    test: evaluate(
      ticks,
      signals,
      merged,
      validationBoundary,
      endEpochExclusive,
    ),
  };
}

export function runRiseOnlySmaFlowBacktest(
  ticks,
  parameters = BROWSER_FLOW_PARAMETERS,
) {
  return runDirectionalSmaFlowBacktest(ticks, "rise", parameters);
}

export function runFallOnlySmaFlowBacktest(
  ticks,
  parameters = BROWSER_FLOW_PARAMETERS,
) {
  return runDirectionalSmaFlowBacktest(ticks, "fall", parameters);
}
