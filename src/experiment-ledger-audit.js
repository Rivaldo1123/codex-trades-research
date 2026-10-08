import { canonicalJson, sha256 } from "./strategy-search-config.js";

function close(left, right, tolerance = 1e-12) {
  if (left === null || right === null) return left === right;
  return Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

export function referenceScore(counts, netProfitOnWin) {
  if (!Number.isSafeInteger(counts?.wins) || counts.wins < 0 ||
      !Number.isSafeInteger(counts?.losses) || counts.losses < 0 ||
      !Number.isSafeInteger(counts?.ties) || counts.ties < 0 ||
      !Number.isSafeInteger(counts?.trades) || counts.trades < 0 ||
      counts.wins + counts.losses !== counts.trades ||
      counts.ties > counts.losses ||
      !Number.isFinite(netProfitOnWin) || netProfitOnWin <= 0) {
    throw new Error("Ledger scenario counts or net win profit are invalid.");
  }
  const netProfit = counts.wins * netProfitOnWin - counts.losses;
  return {
    averageProfitPerDollarStaked:
      counts.trades === 0 ? null : netProfit / counts.trades,
    losses: counts.losses,
    netProfit,
    profitFactor:
      counts.losses === 0 ? null : (counts.wins * netProfitOnWin) / counts.losses,
    ties: counts.ties,
    trades: counts.trades,
    winRate: counts.trades === 0 ? null : counts.wins / counts.trades,
    wins: counts.wins,
  };
}

function assertScore(actual, expected, label) {
  for (const field of [
    "averageProfitPerDollarStaked",
    "netProfit",
    "profitFactor",
    "winRate",
  ]) {
    if (!close(actual?.[field], expected[field])) {
      throw new Error(`${label} has an incorrect ${field}.`);
    }
  }
  for (const field of ["losses", "ties", "trades", "wins"]) {
    if (actual?.[field] !== expected[field]) {
      throw new Error(`${label} has an incorrect ${field}.`);
    }
  }
}

function jsonRepresentableMinimum(values) {
  const minimum = Math.min(...values);
  return Number.isFinite(minimum) ? minimum : null;
}

export function validateExperimentLedgerRecord(record, protocol) {
  if (record?.failed !== false || !record.evaluation ||
      record.configurationHash !== sha256(canonicalJson(record.configuration)) ||
      record.family !== record.configuration.family) {
    throw new Error("Ledger record identity, hash, or completion state is invalid.");
  }
  const expectedScenarioCount = protocol.evaluationWindows.length *
    protocol.parameterRanges.entryDelayTicks.length;
  if (!Array.isArray(record.evaluation.scenarios) ||
      record.evaluation.scenarios.length !== expectedScenarioCount) {
    throw new Error("Ledger record has an incorrect scenario count.");
  }
  const seen = new Set();
  for (const scenario of record.evaluation.scenarios) {
    const identity = `${scenario.windowId}|${scenario.delayTicks}`;
    if (seen.has(identity) ||
        !protocol.evaluationWindows.some((window) => window.id === scenario.windowId) ||
        !protocol.parameterRanges.entryDelayTicks.includes(scenario.delayTicks)) {
      throw new Error("Ledger scenario identity is invalid or duplicated.");
    }
    seen.add(identity);
    for (const payout of protocol.parameterRanges.profitPerDollarOnWin) {
      const expected = referenceScore(scenario.counts, payout);
      assertScore(
        scenario.payoutScores?.[String(payout)],
        expected,
        `Scenario ${identity} payout ${payout}`,
      );
    }
  }
  const baseCounts = record.evaluation.scenarios
    .filter((scenario) => scenario.delayTicks === 1)
    .reduce((total, scenario) => ({
      losses: total.losses + scenario.counts.losses,
      ties: total.ties + scenario.counts.ties,
      trades: total.trades + scenario.counts.trades,
      wins: total.wins + scenario.counts.wins,
    }), { losses: 0, ties: 0, trades: 0, wins: 0 });
  assertScore(
    record.evaluation.base,
    referenceScore(baseCounts, protocol.acceptanceRules.basePayoutOnWin),
    "Aggregate base score",
  );
  const stressValues = record.evaluation.scenarios.map((scenario) =>
    scenario.payoutScores[String(protocol.acceptanceRules.stressPayoutOnWin)]
      .averageProfitPerDollarStaked ?? -Infinity);
  const severeValues = record.evaluation.scenarios.map((scenario) =>
    scenario.payoutScores[
      String(protocol.acceptanceRules.reportedSevereStressPayoutOnWin)
    ].averageProfitPerDollarStaked ?? -Infinity);
  const expectedStressMinimum = jsonRepresentableMinimum(stressValues);
  const expectedSevereMinimum = jsonRepresentableMinimum(severeValues);
  if (!close(
    record.evaluation.minimumStressAverageProfitPerDollarStaked,
    expectedStressMinimum,
  ) || !close(
    record.evaluation.minimumSevereStressAverageProfitPerDollarStaked,
    expectedSevereMinimum,
  )) {
    throw new Error("Ledger minimum stress score is inconsistent with its scenarios.");
  }
  const baseAt095 = referenceScore(baseCounts, 0.95);
  const breakEvenNetProfitOnWin = baseCounts.wins === 0
    ? null
    : baseCounts.losses / baseCounts.wins;
  const outcomeSignature = sha256(JSON.stringify(
    record.evaluation.scenarios.map((scenario) => [
      scenario.windowId,
      scenario.delayTicks,
      scenario.counts.wins,
      scenario.counts.losses,
      scenario.counts.ties,
    ]),
  ));
  return {
    baseAt095,
    breakEvenNetProfitOnWin,
    outcomeSignature,
    severeMinimumEncodedAsNull: expectedSevereMinimum === null,
    stressMinimumEncodedAsNull: expectedStressMinimum === null,
  };
}

export function separateQualificationQuestions(evaluation, protocol) {
  const failures = new Set(evaluation.acceptanceFailures ?? []);
  return {
    baseModel: {
      lost: (evaluation.base.averageProfitPerDollarStaked ?? -Infinity) < 0,
      missedPracticalThreshold:
        (evaluation.base.averageProfitPerDollarStaked ?? -Infinity) <
        protocol.acceptanceRules.minimumBaseAverageProfitPerDollarStaked,
    },
    conservativeStress: {
      anyWindowOrDelayNonPositive: failures.has(
        "stress_not_positive_in_every_window_and_delay",
      ),
      missedPracticalThreshold: failures.has("stress_expectancy_below_minimum"),
    },
    statisticalEvidence: {
      bootstrapEvaluated: Boolean(evaluation.dayBlockBootstrap),
      bootstrapLowerBoundPositive:
        (evaluation.dayBlockBootstrap?.lowerBound ?? -Infinity) > 0,
      multiplicityAdjustedEvidencePassed:
        !failures.has("multiple_testing_adjusted_evidence_failed"),
    },
    operationalOrSample: {
      drawdownFailed: failures.has("maximum_drawdown_exceeded"),
      losingStreakFailed: failures.has("losing_streak_exceeded"),
      minimumActiveDaysFailed: failures.has("too_few_active_days"),
      minimumTotalTradesFailed: failures.has("too_few_total_trades"),
      minimumWindowTradesFailed: failures.has("too_few_trades_in_window"),
    },
  };
}

export function numericSummary(values) {
  if (!Array.isArray(values) || values.length === 0 ||
      values.some((value) => !Number.isFinite(value))) {
    throw new Error("Numeric summary requires finite observations.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.floor((sorted.length - 1) * fraction)];
  return {
    maximum: sorted.at(-1),
    median: percentile(0.5),
    minimum: sorted[0],
  };
}
