export const BROWSER_FLOW_PARAMETERS = Object.freeze({
  entryDelayTicks: 1,
  fastWindow: 10,
  horizonTicks: 1,
  payoutOnLoss: -1,
  payoutOnWin: 0.9,
  slowWindow: 20,
});

function pricePrefix(ticks) {
  const prefix = new Float64Array(ticks.length + 1);
  for (let index = 0; index < ticks.length; index += 1) {
    prefix[index + 1] = prefix[index] + ticks[index].quote;
  }
  return prefix;
}

function evaluate(ticks, prefix, parameters, direction, start, endExclusive) {
  const first = Math.max(start, parameters.slowWindow - 1);
  const last = Math.min(
    endExclusive - parameters.entryDelayTicks - parameters.horizonTicks,
    ticks.length - parameters.entryDelayTicks - parameters.horizonTicks,
  );
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  for (let index = first; index < last; index += 1) {
    const fast =
      (prefix[index + 1] - prefix[index + 1 - parameters.fastWindow]) /
      parameters.fastWindow;
    const slow =
      (prefix[index + 1] - prefix[index + 1 - parameters.slowWindow]) /
      parameters.slowWindow;
    const qualifies = direction === "rise" ? fast > slow : fast < slow;
    if (!qualifies) {
      skipped += 1;
      continue;
    }
    const entryIndex = index + parameters.entryDelayTicks;
    const entry = ticks[entryIndex].quote;
    const exit = ticks[entryIndex + parameters.horizonTicks].quote;
    const won = direction === "rise" ? exit > entry : exit < entry;
    if (won) {
      wins += 1;
    } else {
      // Deriv's recorded one-tick contracts treat an unchanged exit as a loss.
      losses += 1;
    }
  }

  const observations = wins + losses;
  const netProfit =
    wins * parameters.payoutOnWin + losses * parameters.payoutOnLoss;
  return {
    averageProfitPerDollarStake:
      observations === 0 ? null : netProfit / observations,
    losses,
    netProfitPerDollarStake: netProfit,
    observations,
    profitFactor:
      losses === 0 ? null : (wins * parameters.payoutOnWin) / losses,
    skipped,
    winRate: observations === 0 ? null : wins / observations,
    wins,
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
  if (!Number.isInteger(parameters.entryDelayTicks) || parameters.entryDelayTicks < 1) {
    throw new Error("The contract entry delay must be at least one tick.");
  }
  if (
    ticks.length <
    parameters.slowWindow + parameters.entryDelayTicks + parameters.horizonTicks + 100
  ) {
    throw new Error("Not enough ticks for the browser-flow backtest.");
  }
  const prefix = pricePrefix(ticks);
  const trainBoundary = Math.floor(ticks.length * 0.7);
  const validationBoundary = Math.floor(ticks.length * 0.85);
  return {
    generatedAt: new Date().toISOString(),
    flow:
      direction === "rise"
        ? "Buy one-tick Rise only when SMA(10) > SMA(20); otherwise wait"
        : "Buy one-tick Fall only when SMA(10) < SMA(20); otherwise wait",
    input: {
      firstEpoch: ticks[0].epoch,
      lastEpoch: ticks.at(-1).epoch,
      ticks: ticks.length,
    },
    methodology: {
      entryTiming:
        "The signal uses the current tick. A contract enters on the following tick and settles after the configured duration; execution delay beyond one tick is not modeled.",
      payoutModel:
        `Each qualifying $1 contract is scored +$0.90 for a correct ${direction} and -$1.00 for the opposite move or a tie, matching the captured Demo batches.`,
      selection:
        `The 10/20 windows came from the prior validation-selected one-tick SMA candidate. This report measures the symmetric ${direction}-only gate without reselecting on the test segment.`,
      split: "Chronological 70/15/15; each entry and settlement remains inside its own split.",
    },
    parameters: { ...parameters, direction },
    training: evaluate(
      ticks,
      prefix,
      parameters,
      direction,
      0,
      trainBoundary,
    ),
    validation: evaluate(
      ticks,
      prefix,
      parameters,
      direction,
      trainBoundary,
      validationBoundary,
    ),
    test: evaluate(
      ticks,
      prefix,
      parameters,
      direction,
      validationBoundary,
      ticks.length,
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
