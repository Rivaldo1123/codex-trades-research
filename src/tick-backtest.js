import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function buildPricePrefix(ticks) {
  const prefix = new Float64Array(ticks.length + 1);
  for (let index = 0; index < ticks.length; index += 1) {
    prefix[index + 1] = prefix[index] + ticks[index].quote;
  }
  return prefix;
}

function evaluateRange(ticks, prefix, parameters, start, endExclusive) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let sum = 0;
  const first = Math.max(start, parameters.slowWindow - 1);
  const last = Math.min(endExclusive, ticks.length - parameters.horizonTicks);
  for (let index = first; index < last; index += 1) {
    const fast =
      (prefix[index + 1] - prefix[index + 1 - parameters.fastWindow]) /
      parameters.fastWindow;
    const slow =
      (prefix[index + 1] - prefix[index + 1 - parameters.slowWindow]) /
      parameters.slowWindow;
    const direction = fast > slow ? 1 : -1;
    const marketReturn =
      ticks[index + parameters.horizonTicks].quote / ticks[index].quote - 1;
    const signedReturn = direction * marketReturn;
    sum += signedReturn;
    if (signedReturn > 0) wins += 1;
    else if (signedReturn < 0) losses += 1;
    else ties += 1;
  }
  const observations = wins + losses + ties;
  return {
    averageSignedReturn: observations === 0 ? null : sum / observations,
    losses,
    observations,
    positiveRate: observations === 0 ? null : wins / observations,
    ties,
    wins,
  };
}

function isBetter(candidate, best) {
  if (!best) return true;
  if (candidate.positiveRate !== best.positiveRate) {
    return candidate.positiveRate > best.positiveRate;
  }
  if (candidate.averageSignedReturn !== best.averageSignedReturn) {
    return candidate.averageSignedReturn > best.averageSignedReturn;
  }
  return false;
}

export function runPurgedSmaBacktest(ticks, config) {
  const maxSlow = Math.max(...config.backtestSlowWindows);
  const maxHorizon = Math.max(...config.horizonsTicks);
  if (ticks.length < maxSlow + maxHorizon + 100) {
    throw new Error(
      `Need at least ${maxSlow + maxHorizon + 100} ticks to backtest; found ${ticks.length}.`,
    );
  }
  const prefix = buildPricePrefix(ticks);
  const trainBoundary = Math.floor(ticks.length * 0.7);
  const validationBoundary = Math.floor(ticks.length * 0.85);
  const results = [];

  for (const horizonTicks of config.horizonsTicks) {
    let best = null;
    let candidateCount = 0;
    for (const fastWindow of config.backtestFastWindows) {
      for (const slowWindow of config.backtestSlowWindows) {
        if (fastWindow >= slowWindow) continue;
        candidateCount += 1;
        const parameters = { fastWindow, horizonTicks, slowWindow };
        const validation = evaluateRange(
          ticks,
          prefix,
          parameters,
          trainBoundary,
          validationBoundary - horizonTicks,
        );
        const candidate = { ...parameters, ...validation };
        if (isBetter(candidate, best)) best = candidate;
      }
    }
    const selected = {
      fastWindow: best.fastWindow,
      horizonTicks,
      slowWindow: best.slowWindow,
    };
    results.push({
      candidateCount,
      selected,
      training: evaluateRange(
        ticks,
        prefix,
        selected,
        0,
        trainBoundary - horizonTicks,
      ),
      validation: {
        averageSignedReturn: best.averageSignedReturn,
        losses: best.losses,
        observations: best.observations,
        positiveRate: best.positiveRate,
        ties: best.ties,
        wins: best.wins,
      },
      test: evaluateRange(
        ticks,
        prefix,
        selected,
        validationBoundary,
        ticks.length - horizonTicks,
      ),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    input: {
      firstEpoch: ticks[0].epoch,
      lastEpoch: ticks.at(-1).epoch,
      ticks: ticks.length,
    },
    methodology: {
      caveat:
        "Directional tick returns exclude Deriv payout, spread, and execution effects; profitability is not established by this test.",
      modelSelection:
        "Each horizon selects SMA windows on validation data only; its untouched test segment is evaluated once.",
      split:
        "Chronological 70/15/15 with each earlier segment purged by the evaluated horizon.",
    },
    results,
  };
}

export async function writeBacktestReport({ config, projectRoot, ticks }) {
  const report = {
    mode: "public-data-only",
    symbol: config.symbol,
    ...runPurgedSmaBacktest(ticks, config),
  };
  const directory = path.join(projectRoot, "data", "backtests", config.symbol);
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `${safeTimestamp()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}
