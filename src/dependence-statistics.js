import { oneSidedStudentTPValue } from "./strategy-search-engine.js";

function validateDayBlock(block) {
  if (!Number.isSafeInteger(block?.wins) || block.wins < 0 ||
      !Number.isSafeInteger(block?.losses) || block.losses < 0 ||
      !Number.isSafeInteger(block?.trades) || block.trades < 0 ||
      block.wins + block.losses !== block.trades) {
    throw new Error("UTC-day outcome block has invalid counts.");
  }
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

function net(block, netProfitOnWin) {
  return block.wins * netProfitOnWin - block.losses;
}

export function clusteredRatioTTest(
  dayBlocks,
  { comparisons = 1, netProfitOnWin },
) {
  if (!Array.isArray(dayBlocks) || dayBlocks.length < 2 ||
      !Number.isFinite(netProfitOnWin) || netProfitOnWin <= 0 ||
      !Number.isSafeInteger(comparisons) || comparisons < 1) {
    throw new Error("Clustered ratio test settings are invalid.");
  }
  dayBlocks.forEach(validateDayBlock);
  const active = dayBlocks.filter((block) => block.trades > 0);
  const totalTrades = active.reduce((sum, block) => sum + block.trades, 0);
  const totalNetProfit = active.reduce(
    (sum, block) => sum + net(block, netProfitOnWin),
    0,
  );
  if (active.length < 2 || totalTrades === 0) {
    return {
      activeUtcDayClusters: active.length,
      adjustedPValueBonferroni: 1,
      averageNetProfitPerUnitStaked: null,
      rawOneSidedPValue: 1,
      reason: "At least two active UTC-day clusters are required.",
      standardError: null,
      tStatistic: null,
      totalTrades,
    };
  }
  const estimate = totalNetProfit / totalTrades;
  const meanTrades = totalTrades / active.length;
  const influence = active.map(
    (block) => net(block, netProfitOnWin) - estimate * block.trades,
  );
  const variance = influence.reduce((sum, value) => sum + value * value, 0) /
    (active.length - 1);
  const standardError = Math.sqrt(variance / active.length) / meanTrades;
  const tStatistic = standardError === 0
    ? estimate > 0 ? Infinity : -Infinity
    : estimate / standardError;
  const rawOneSidedPValue = oneSidedStudentTPValue(
    tStatistic,
    active.length - 1,
  );
  return {
    activeUtcDayClusters: active.length,
    adjustedPValueBonferroni: Math.min(1, rawOneSidedPValue * comparisons),
    assumptions: [
      "UTC-day clusters are mutually independent for the Student-t approximation.",
      "The ratio-estimator cluster influence has a finite second moment.",
    ],
    averageNetProfitPerUnitStaked: estimate,
    rawOneSidedPValue,
    standardError,
    tStatistic,
    totalNetProfit,
    totalTrades,
  };
}

export function movingDayBlockBootstrapLowerBound(
  dayBlocks,
  {
    blockLengthDays = 3,
    confidence = 0.99,
    netProfitOnWin,
    repetitions = 20_000,
    seed = 1,
  },
) {
  if (!Array.isArray(dayBlocks) || dayBlocks.length < 2 ||
      !Number.isSafeInteger(blockLengthDays) || blockLengthDays < 1 ||
      blockLengthDays > dayBlocks.length ||
      !Number.isFinite(netProfitOnWin) || netProfitOnWin <= 0 ||
      !Number.isSafeInteger(repetitions) || repetitions < 100 ||
      !Number.isSafeInteger(seed) || confidence <= 0 || confidence >= 1) {
    throw new Error("Moving-day-block bootstrap settings are invalid.");
  }
  dayBlocks.forEach(validateDayBlock);
  const random = mulberry32(seed);
  const estimates = [];
  for (let replication = 0; replication < repetitions; replication += 1) {
    let sampled = 0;
    let totalNetProfit = 0;
    let totalTrades = 0;
    while (sampled < dayBlocks.length) {
      const start = Math.floor(random() * dayBlocks.length);
      for (let offset = 0;
        offset < blockLengthDays && sampled < dayBlocks.length;
        offset += 1) {
        const block = dayBlocks[(start + offset) % dayBlocks.length];
        totalNetProfit += net(block, netProfitOnWin);
        totalTrades += block.trades;
        sampled += 1;
      }
    }
    if (totalTrades > 0) estimates.push(totalNetProfit / totalTrades);
  }
  if (estimates.length < repetitions * 0.99) {
    return {
      blockLengthDays,
      confidence,
      lowerBound: null,
      reason: "Too many bootstrap resamples had zero stake exposure.",
      repetitions,
      seed,
    };
  }
  estimates.sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(estimates.length - 1, Math.ceil((1 - confidence) * estimates.length) - 1),
  );
  return {
    assumptions: [
      "Circular moving blocks of UTC days approximate the relevant serial dependence.",
      "Thirty calendar days are enough to estimate the requested tail; this is weak for 99% bounds.",
    ],
    blockLengthDays,
    confidence,
    lowerBound: estimates[index],
    repetitions,
    seed,
  };
}
