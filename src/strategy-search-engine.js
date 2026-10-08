import { createHash } from "node:crypto";

function key(...parts) {
  return parts.join(":");
}

function stats(values) {
  if (values.length === 0) return { mean: null, sampleSd: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean, sampleSd: null };
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return { mean, sampleSd: Math.sqrt(variance) };
}

// Lanczos log-gamma plus the continued-fraction incomplete beta are used only
// for a one-sided Student t probability on independent UTC-day blocks.
function logGamma(value) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019571e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return (
      Math.log(Math.PI) -
      Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value)
    );
  }
  let x = 0.9999999999998099;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) {
    x += coefficients[index] / (z + index + 1);
  }
  const t = z + coefficients.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (z + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
}

function betaFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const doubled = 2 * iteration;
    let aa =
      (iteration * (b - iteration) * x) /
      ((qam + doubled) * (a + doubled));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    aa =
      (-(a + iteration) * (qab + iteration) * x) /
      ((a + doubled) * (qap + doubled));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (factor * betaFraction(a, b, x)) / a;
  }
  return 1 - (factor * betaFraction(b, a, 1 - x)) / b;
}

export function oneSidedStudentTPValue(tStatistic, degreesOfFreedom) {
  if (!Number.isFinite(tStatistic) || degreesOfFreedom < 1) {
    return tStatistic === Infinity ? 0 : 1;
  }
  const x =
    degreesOfFreedom /
    (degreesOfFreedom + tStatistic * tStatistic);
  const halfTail =
    0.5 * regularizedBeta(x, degreesOfFreedom / 2, 0.5);
  return tStatistic >= 0 ? halfTail : 1 - halfTail;
}

function windowForEpoch(protocol, epoch) {
  return protocol.evaluationWindows.findIndex(
    (window) =>
      epoch >= window.fromEpochInclusive &&
      epoch < window.toEpochExclusive,
  );
}

function maximumLookback(config) {
  return Math.max(
    config.fastWindow ?? 1,
    config.slowWindow ?? 1,
    config.lookbackTicks ?? 1,
    config.volatilityWindow ?? 1,
  );
}

export function buildSearchFeatureCache({ protocol, quotes, present }) {
  const fromEpoch = protocol.dataset.fromEpochInclusive;
  const toEpochExclusive = protocol.dataset.toEpochExclusive;
  const slots = toEpochExclusive - fromEpoch;
  if (
    !(quotes instanceof Float64Array) ||
    !(present instanceof Uint8Array) ||
    quotes.length !== slots ||
    present.length !== slots
  ) {
    throw new Error("Search features require an exact price/presence slot for every UTC second.");
  }
  const sum = new Float64Array(slots + 1);
  const squared = new Float64Array(slots + 1);
  const missing = new Uint32Array(slots + 1);
  for (let index = 0; index < slots; index += 1) {
    const value = present[index] ? quotes[index] : 0;
    sum[index + 1] = sum[index] + value;
    squared[index + 1] = squared[index] + value * value;
    missing[index + 1] = missing[index] + (present[index] ? 0 : 1);
  }
  const decisionSlots = [];
  const decisionEpochs = [];
  const decisionWindows = [];
  const decisionDays = [];
  for (
    let epoch = Math.ceil(fromEpoch / protocol.decisionSampling.utcCadenceSeconds) *
      protocol.decisionSampling.utcCadenceSeconds;
    epoch < toEpochExclusive;
    epoch += protocol.decisionSampling.utcCadenceSeconds
  ) {
    const slot = epoch - fromEpoch;
    if (!present[slot]) continue;
    const windowIndex = windowForEpoch(protocol, epoch);
    if (windowIndex < 0) continue;
    decisionSlots.push(slot);
    decisionEpochs.push(epoch);
    decisionWindows.push(windowIndex);
    decisionDays.push(Math.floor((epoch - fromEpoch) / 86_400));
  }
  const slotsArray = Int32Array.from(decisionSlots);
  const epochsArray = Int32Array.from(decisionEpochs);
  const windowsArray = Uint8Array.from(decisionWindows);
  const daysArray = Uint8Array.from(decisionDays);
  const means = new Map();
  const standardDeviations = new Map();
  const momentums = new Map();
  const channelHighs = new Map();
  const channelLows = new Map();
  const outcomeDirections = new Map();
  const outcomeValid = new Map();

  const segmentStartSlot = (decisionIndex) =>
    protocol.evaluationWindows[windowsArray[decisionIndex]].fromEpochInclusive -
    fromEpoch;
  const segmentEndSlot = (decisionIndex) =>
    protocol.evaluationWindows[windowsArray[decisionIndex]].toEpochExclusive -
    fromEpoch;
  const rangePresent = (start, endExclusive) =>
    start >= 0 &&
    endExclusive <= slots &&
    missing[endExclusive] - missing[start] === 0;

  const requiredMeanWindows = new Set([
    ...protocol.parameterRanges.sma.fastWindows,
    ...protocol.parameterRanges.sma.slowWindows,
    ...protocol.parameterRanges.sma.volatilityWindows,
    ...protocol.parameterRanges.momentum.volatilityWindows,
    ...protocol.parameterRanges.channel.volatilityWindows,
    ...protocol.parameterRanges.zscore.volatilityWindows,
    ...protocol.parameterRanges.zscore.lookbackTicks,
  ]);
  for (const window of requiredMeanWindows) {
    const meanValues = new Float64Array(slotsArray.length);
    const sdValues = new Float64Array(slotsArray.length);
    meanValues.fill(Number.NaN);
    sdValues.fill(Number.NaN);
    for (let decision = 0; decision < slotsArray.length; decision += 1) {
      const end = slotsArray[decision] + 1;
      const start = end - window;
      if (start < segmentStartSlot(decision) || !rangePresent(start, end)) continue;
      const mean = (sum[end] - sum[start]) / window;
      const variance = Math.max(
        0,
        (squared[end] - squared[start]) / window - mean * mean,
      );
      meanValues[decision] = mean;
      sdValues[decision] = Math.sqrt(variance);
    }
    means.set(window, meanValues);
    standardDeviations.set(window, sdValues);
  }

  for (const lookback of protocol.parameterRanges.momentum.lookbackTicks) {
    const values = new Float64Array(slotsArray.length);
    values.fill(Number.NaN);
    for (let decision = 0; decision < slotsArray.length; decision += 1) {
      const slot = slotsArray[decision];
      const start = slot - lookback;
      if (
        start < segmentStartSlot(decision) ||
        !rangePresent(start, slot + 1) ||
        quotes[start] === 0
      ) {
        continue;
      }
      values[decision] = ((quotes[slot] - quotes[start]) / quotes[start]) * 10_000;
    }
    momentums.set(lookback, values);
  }

  for (const lookback of protocol.parameterRanges.channel.lookbackTicks) {
    const highs = new Float64Array(slotsArray.length);
    const lows = new Float64Array(slotsArray.length);
    highs.fill(Number.NaN);
    lows.fill(Number.NaN);
    for (let decision = 0; decision < slotsArray.length; decision += 1) {
      const slot = slotsArray[decision];
      const start = slot - lookback;
      if (start < segmentStartSlot(decision) || !rangePresent(start, slot + 1)) {
        continue;
      }
      let high = -Infinity;
      let low = Infinity;
      for (let index = start; index < slot; index += 1) {
        high = Math.max(high, quotes[index]);
        low = Math.min(low, quotes[index]);
      }
      highs[decision] = high;
      lows[decision] = low;
    }
    channelHighs.set(lookback, highs);
    channelLows.set(lookback, lows);
  }

  for (const duration of protocol.parameterRanges.durationsTicks) {
    for (const delay of protocol.parameterRanges.entryDelayTicks) {
      const directions = new Int8Array(slotsArray.length);
      const valid = new Uint8Array(slotsArray.length);
      for (let decision = 0; decision < slotsArray.length; decision += 1) {
        const slot = slotsArray[decision];
        const entry = slot + delay;
        const settlement = entry + duration;
        if (
          settlement >= segmentEndSlot(decision) ||
          !rangePresent(slot, settlement + 1)
        ) {
          continue;
        }
        const change = quotes[settlement] - quotes[entry];
        directions[decision] = change > 0 ? 1 : change < 0 ? -1 : 0;
        valid[decision] = 1;
      }
      outcomeDirections.set(key(duration, delay), directions);
      outcomeValid.set(key(duration, delay), valid);
    }
  }

  return {
    channelHighs,
    channelLows,
    decisionDays: daysArray,
    decisionEpochs: epochsArray,
    decisionSlots: slotsArray,
    decisionWindows: windowsArray,
    means,
    momentums,
    outcomeDirections,
    outcomeValid,
    quotes,
    standardDeviations,
    metadata: {
      decisions: slotsArray.length,
      featureBytes:
        sum.byteLength +
        squared.byteLength +
        missing.byteLength +
        [...means.values()].reduce((total, item) => total + item.byteLength, 0) +
        [...standardDeviations.values()].reduce(
          (total, item) => total + item.byteLength,
          0,
        ) +
        [...momentums.values()].reduce((total, item) => total + item.byteLength, 0) +
        [...channelHighs.values()].reduce((total, item) => total + item.byteLength, 0) +
        [...channelLows.values()].reduce((total, item) => total + item.byteLength, 0) +
        [...outcomeDirections.values()].reduce(
          (total, item) => total + item.byteLength,
          0,
        ) +
        [...outcomeValid.values()].reduce(
          (total, item) => total + item.byteLength,
          0,
        ),
    },
  };
}

function signalFor(config, cache, decision) {
  const slot = cache.decisionSlots[decision];
  const quote = cache.quotes[slot];
  if (config.family === "unconditional_baseline") {
    return config.direction === "rise" ? 1 : -1;
  }
  const volatilityMean = cache.means.get(config.volatilityWindow)?.[decision];
  const volatilitySd =
    cache.standardDeviations.get(config.volatilityWindow)?.[decision];
  if (!Number.isFinite(volatilityMean) || !Number.isFinite(volatilitySd)) return 0;
  const volatilityBps =
    volatilityMean === 0 ? 0 : (volatilitySd / Math.abs(volatilityMean)) * 10_000;
  if (volatilityBps < config.minimumVolatilityBps) return 0;

  if (config.family === "sma_trend" || config.family === "sma_reversion") {
    const fast = cache.means.get(config.fastWindow)?.[decision];
    const slow = cache.means.get(config.slowWindow)?.[decision];
    if (!Number.isFinite(fast) || !Number.isFinite(slow) || quote === 0) return 0;
    const separation = ((fast - slow) / Math.abs(quote)) * 10_000;
    const trend =
      separation > config.thresholdBps
        ? 1
        : separation < -config.thresholdBps
          ? -1
          : 0;
    return config.family === "sma_trend" ? trend : -trend;
  }
  if (
    config.family === "momentum_trend" ||
    config.family === "momentum_reversion"
  ) {
    const momentum = cache.momentums.get(config.lookbackTicks)?.[decision];
    if (!Number.isFinite(momentum)) return 0;
    const trend =
      momentum > config.thresholdBps
        ? 1
        : momentum < -config.thresholdBps
          ? -1
          : 0;
    return config.family === "momentum_trend" ? trend : -trend;
  }
  if (config.family === "channel_breakout") {
    const high = cache.channelHighs.get(config.lookbackTicks)?.[decision];
    const low = cache.channelLows.get(config.lookbackTicks)?.[decision];
    if (!Number.isFinite(high) || !Number.isFinite(low)) return 0;
    const buffer = config.thresholdBps / 10_000;
    return quote > high * (1 + buffer)
      ? 1
      : quote < low * (1 - buffer)
        ? -1
        : 0;
  }
  if (config.family === "zscore_reversion") {
    const mean = cache.means.get(config.lookbackTicks)?.[decision];
    const sd = cache.standardDeviations.get(config.lookbackTicks)?.[decision];
    if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd === 0) return 0;
    const z = (quote - mean) / sd;
    return z > config.thresholdZ ? -1 : z < -config.thresholdZ ? 1 : 0;
  }
  throw new Error(`Unknown strategy family: ${config.family}`);
}

function scoreCounts(counts, payoutOnWin) {
  const netProfit = counts.wins * payoutOnWin - counts.losses;
  return {
    averageProfitPerDollarStaked:
      counts.trades === 0 ? null : netProfit / counts.trades,
    losses: counts.losses,
    netProfit,
    profitFactor:
      counts.losses === 0 ? null : (counts.wins * payoutOnWin) / counts.losses,
    ties: counts.ties,
    trades: counts.trades,
    winRate: counts.trades === 0 ? null : counts.wins / counts.trades,
    wins: counts.wins,
  };
}

function dayBlockTest(dayCounts, payoutOnWin, comparisons) {
  const dayReturns = dayCounts
    .filter((item) => item.trades > 0)
    .map((item) => (item.wins * payoutOnWin - item.losses) / item.trades);
  const summary = stats(dayReturns);
  const standardError =
    summary.sampleSd === null
      ? null
      : summary.sampleSd / Math.sqrt(dayReturns.length);
  const tStatistic =
    standardError === 0
      ? summary.mean > 0
        ? Infinity
        : -Infinity
      : standardError === null
        ? null
        : summary.mean / standardError;
  const rawPValue =
    tStatistic === null
      ? 1
      : oneSidedStudentTPValue(tStatistic, dayReturns.length - 1);
  return {
    activeDayBlockReturns: dayReturns,
    activeDays: dayReturns.length,
    adjustedPValueBonferroni: Math.min(1, rawPValue * comparisons),
    block: "UTC calendar day",
    meanDailyAverageReturn: summary.mean,
    rawOneSidedPValue: rawPValue,
    sampleSdDailyAverageReturn: summary.sampleSd,
    tStatistic,
  };
}

export function evaluateSearchConfiguration({
  cache,
  config,
  protocol,
}) {
  const delays = protocol.parameterRanges.entryDelayTicks;
  const windows = protocol.evaluationWindows;
  const counts = windows.map(() =>
    delays.map(() => ({ losses: 0, ties: 0, trades: 0, wins: 0 })),
  );
  const totalDays = Math.ceil(
    (protocol.dataset.toEpochExclusive -
      protocol.dataset.fromEpochInclusive) /
      86_400,
  );
  const dailyByDelay = delays.map(() =>
    Array.from({ length: totalDays }, () => ({
      losses: 0,
      ties: 0,
      trades: 0,
      wins: 0,
    })),
  );
  const outcomes = delays.map((delay) =>
    cache.outcomeDirections.get(key(config.durationTicks, delay)),
  );
  const validOutcomes = delays.map((delay) =>
    cache.outcomeValid.get(key(config.durationTicks, delay)),
  );
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  let losingStreak = 0;
  let longestLosingStreak = 0;
  const activeDays = new Set();
  const basePayout = protocol.acceptanceRules.basePayoutOnWin;

  for (let decision = 0; decision < cache.decisionSlots.length; decision += 1) {
    const signal = signalFor(config, cache, decision);
    if (signal === 0) continue;
    const windowIndex = cache.decisionWindows[decision];
    const day = cache.decisionDays[decision];
    for (let delayIndex = 0; delayIndex < delays.length; delayIndex += 1) {
      if (!validOutcomes[delayIndex][decision]) continue;
      const outcome = outcomes[delayIndex][decision];
      const won = (signal === 1 && outcome === 1) || (signal === -1 && outcome === -1);
      const target = counts[windowIndex][delayIndex];
      const daily = dailyByDelay[delayIndex][day];
      target.trades += 1;
      daily.trades += 1;
      if (won) {
        target.wins += 1;
        daily.wins += 1;
      } else {
        target.losses += 1;
        daily.losses += 1;
        if (outcome === 0) {
          target.ties += 1;
          daily.ties += 1;
        }
      }
      if (delayIndex === 0) {
        activeDays.add(day);
        const tradeReturn = won ? basePayout : -1;
        equity += tradeReturn;
        peak = Math.max(peak, equity);
        maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
        losingStreak = won ? 0 : losingStreak + 1;
        longestLosingStreak = Math.max(longestLosingStreak, losingStreak);
      }
    }
  }

  const scenarios = [];
  const baseWindowScores = [];
  const stressWindowDelayScores = [];
  const severeWindowDelayScores = [];
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    for (let delayIndex = 0; delayIndex < delays.length; delayIndex += 1) {
      const scenarioCounts = counts[windowIndex][delayIndex];
      const payoutScores = Object.fromEntries(
        protocol.parameterRanges.profitPerDollarOnWin.map((payout) => [
          String(payout),
          scoreCounts(scenarioCounts, payout),
        ]),
      );
      scenarios.push({
        counts: scenarioCounts,
        delayTicks: delays[delayIndex],
        payoutScores,
        windowId: windows[windowIndex].id,
      });
      if (delayIndex === 0) {
        baseWindowScores.push(
          payoutScores[String(protocol.acceptanceRules.basePayoutOnWin)],
        );
      }
      stressWindowDelayScores.push(
        payoutScores[String(protocol.acceptanceRules.stressPayoutOnWin)],
      );
      severeWindowDelayScores.push(
        payoutScores[
          String(protocol.acceptanceRules.reportedSevereStressPayoutOnWin)
        ],
      );
    }
  }
  const baseCounts = counts.reduce(
    (total, windowCounts) => {
      const item = windowCounts[0];
      total.wins += item.wins;
      total.losses += item.losses;
      total.ties += item.ties;
      total.trades += item.trades;
      return total;
    },
    { losses: 0, ties: 0, trades: 0, wins: 0 },
  );
  const base = scoreCounts(baseCounts, basePayout);
  const delayStressTotals = delays.map((delay, delayIndex) => {
    const aggregate = counts.reduce(
      (total, windowCounts) => {
        const item = windowCounts[delayIndex];
        total.wins += item.wins;
        total.losses += item.losses;
        total.ties += item.ties;
        total.trades += item.trades;
        return total;
      },
      { losses: 0, ties: 0, trades: 0, wins: 0 },
    );
    return {
      delay,
      score: scoreCounts(
        aggregate,
        protocol.acceptanceRules.stressPayoutOnWin,
      ),
    };
  });
  const worstDelay = [...delayStressTotals].sort(
    (left, right) =>
      (left.score.averageProfitPerDollarStaked ?? -Infinity) -
      (right.score.averageProfitPerDollarStaked ?? -Infinity),
  )[0];
  const uncertainty = dayBlockTest(
    dailyByDelay[delays.indexOf(worstDelay.delay)],
    protocol.acceptanceRules.stressPayoutOnWin,
    protocol.searchBudget.plannedUniqueConfigurations,
  );
  const minimumStressAverage = Math.min(
    ...stressWindowDelayScores.map(
      (item) => item.averageProfitPerDollarStaked ?? -Infinity,
    ),
  );
  const minimumSevereStressAverage = Math.min(
    ...severeWindowDelayScores.map(
      (item) => item.averageProfitPerDollarStaked ?? -Infinity,
    ),
  );
  const rules = protocol.acceptanceRules;
  const failures = [];
  if ((base.averageProfitPerDollarStaked ?? -Infinity) < rules.minimumBaseAverageProfitPerDollarStaked) {
    failures.push("base_expectancy_below_minimum");
  }
  if (minimumStressAverage < rules.minimumStressAverageProfitPerDollarStaked) {
    failures.push("stress_expectancy_below_minimum");
  }
  if (base.trades < rules.minimumSettledTradesTotal) {
    failures.push("too_few_total_trades");
  }
  if (
    baseWindowScores.some(
      (item) => item.trades < rules.minimumSettledTradesPerWindow,
    )
  ) {
    failures.push("too_few_trades_in_window");
  }
  if (activeDays.size < rules.minimumActiveCalendarDays) {
    failures.push("too_few_active_days");
  }
  if (maximumDrawdown > rules.maximumDrawdownStakeUnits) {
    failures.push("maximum_drawdown_exceeded");
  }
  if (longestLosingStreak > rules.maximumLongestLosingStreak) {
    failures.push("losing_streak_exceeded");
  }
  if (
    stressWindowDelayScores.filter(
      (item) => (item.averageProfitPerDollarStaked ?? -Infinity) > 0,
    ).length !== stressWindowDelayScores.length
  ) {
    failures.push("stress_not_positive_in_every_window_and_delay");
  }
  if (uncertainty.adjustedPValueBonferroni > rules.familyWiseAlpha) {
    failures.push("multiple_testing_adjusted_evidence_failed");
  }
  return {
    activity: {
      activeCalendarDays: activeDays.size,
      decisionsSampled: cache.decisionSlots.length,
      maximumLookbackTicks: maximumLookback(config),
    },
    base,
    drawdown: {
      longestLosingStreak,
      maximumDrawdownStakeUnits: maximumDrawdown,
    },
    minimumSevereStressAverageProfitPerDollarStaked:
      minimumSevereStressAverage,
    minimumStressAverageProfitPerDollarStaked: minimumStressAverage,
    preAcceptanceFailures: failures,
    scenarios,
    uncertainty,
    worstStressDelayTicks: worstDelay.delay,
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function dayBlockBootstrapLowerBound(
  values,
  { confidence, repetitions, seed },
) {
  if (
    !Array.isArray(values) ||
    values.length < 2 ||
    !Number.isInteger(repetitions) ||
    repetitions < 100 ||
    confidence <= 0 ||
    confidence >= 1
  ) {
    return {
      confidence,
      lowerBound: null,
      reason: "Insufficient active UTC-day blocks or invalid bootstrap settings.",
      repetitions,
      seed,
    };
  }
  const random = mulberry32(seed);
  const means = new Float64Array(repetitions);
  for (let replication = 0; replication < repetitions; replication += 1) {
    let total = 0;
    for (let sample = 0; sample < values.length; sample += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    means[replication] = total / values.length;
  }
  means.sort();
  return {
    block: "UTC calendar day",
    confidence,
    lowerBound: means[Math.floor((1 - confidence) * repetitions)],
    repetitions,
    seed,
  };
}

function comparableParameters(item) {
  return Object.fromEntries(
    Object.entries(item).filter(
      ([name, value]) =>
        !["configHash", "strategyId", "family"].includes(name) &&
        typeof value === "number",
    ),
  );
}

function configurationDistance(left, right) {
  const a = comparableParameters(left);
  const b = comparableParameters(right);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  let distance = 0;
  for (const name of names) {
    if (!(name in a) || !(name in b)) {
      distance += 1;
      continue;
    }
    const scale = Math.max(Math.abs(a[name]), Math.abs(b[name]), 1);
    distance += Math.abs(a[name] - b[name]) / scale;
  }
  return distance;
}

export function addRobustnessChecks({
  configurationsByHash,
  protocol,
  results,
  candidateCount = 100,
}) {
  const ranked = [...results].sort(
    (left, right) =>
      right.evaluation.minimumStressAverageProfitPerDollarStaked -
        left.evaluation.minimumStressAverageProfitPerDollarStaked ||
      left.evaluation.uncertainty.adjustedPValueBonferroni -
        right.evaluation.uncertainty.adjustedPValueBonferroni ||
      right.evaluation.base.averageProfitPerDollarStaked -
        left.evaluation.base.averageProfitPerDollarStaked,
  );
  const byFamily = Map.groupBy(results, (item) => item.family);
  for (const item of ranked.slice(0, candidateCount)) {
    const config = configurationsByHash.get(item.configHash);
    const neighbors = (byFamily.get(item.family) ?? [])
      .filter((candidate) => candidate.configHash !== item.configHash)
      .map((candidate) => ({
        candidate,
        distance: configurationDistance(
          config,
          configurationsByHash.get(candidate.configHash),
        ),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.candidate.configHash.localeCompare(right.candidate.configHash),
      )
      .slice(0, protocol.acceptanceRules.nearbyConfigurations);
    const positive = neighbors.filter(
      ({ candidate }) =>
        candidate.evaluation.minimumStressAverageProfitPerDollarStaked > 0,
    ).length;
    item.evaluation.nearbySettings = {
      evaluated: neighbors.length,
      positiveFraction:
        neighbors.length === 0 ? 0 : positive / neighbors.length,
      neighbors: neighbors.map(({ candidate, distance }) => ({
        configHash: candidate.configHash,
        distance,
        minimumStressAverageProfitPerDollarStaked:
          candidate.evaluation.minimumStressAverageProfitPerDollarStaked,
      })),
    };
  }
  const bootstrapCandidates = ranked.slice(0, 20);
  for (const [index, item] of bootstrapCandidates.entries()) {
    const seedMaterial = createHash("sha256")
      .update(
        `${protocol.acceptanceRules.bootstrapSeed}|${item.configHash}|${index}`,
      )
      .digest();
    const seed = seedMaterial.readUInt32LE(0);
    item.evaluation.dayBlockBootstrap = dayBlockBootstrapLowerBound(
      item.evaluation.uncertainty.activeDayBlockReturns,
      {
        confidence: protocol.acceptanceRules.bootstrapConfidence,
        repetitions: protocol.acceptanceRules.bootstrapRepetitions,
        seed,
      },
    );
  }
  for (const item of results) {
    const failures = [...item.evaluation.preAcceptanceFailures];
    if (
      !item.evaluation.nearbySettings ||
      item.evaluation.nearbySettings.positiveFraction <
        protocol.acceptanceRules.minimumNearbyPositiveFraction
    ) {
      failures.push("nearby_setting_stability_failed_or_not_shortlisted");
    }
    if (
      !item.evaluation.dayBlockBootstrap ||
      !(
        item.evaluation.dayBlockBootstrap.lowerBound >
        0
      )
    ) {
      failures.push("day_block_bootstrap_failed_or_not_shortlisted");
    }
    item.evaluation.acceptanceFailures = [...new Set(failures)];
    item.evaluation.qualifiesDevelopment =
      item.evaluation.acceptanceFailures.length === 0;
  }
  return ranked;
}
