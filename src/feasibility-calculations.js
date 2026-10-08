export const SKEW_STEP_DISTRIBUTIONS = Object.freeze({
  skew5Up: Object.freeze([
    Object.freeze({ move: -1, probability: 0.10 }),
    Object.freeze({ move: 0.1, probability: 0.83 }),
    Object.freeze({ move: 0.2, probability: 0.05 }),
    Object.freeze({ move: 0.3, probability: 0.01 }),
    Object.freeze({ move: 0.4, probability: 0.01 }),
  ]),
  skew5Down: Object.freeze([
    Object.freeze({ move: 1, probability: 0.10 }),
    Object.freeze({ move: -0.1, probability: 0.83 }),
    Object.freeze({ move: -0.2, probability: 0.05 }),
    Object.freeze({ move: -0.3, probability: 0.01 }),
    Object.freeze({ move: -0.4, probability: 0.01 }),
  ]),
  skew4UpSectionTable: Object.freeze([
    Object.freeze({ move: 1, probability: 0.10 }),
    Object.freeze({ move: -0.1, probability: 0.83 }),
    Object.freeze({ move: -0.2, probability: 0.05 }),
    Object.freeze({ move: -0.3, probability: 0.01 }),
    Object.freeze({ move: -0.4, probability: 0.01 }),
  ]),
  skew4DownSectionTable: Object.freeze([
    Object.freeze({ move: 0.5, probability: 0.20 }),
    Object.freeze({ move: -0.1, probability: 0.65 }),
    Object.freeze({ move: -0.2, probability: 0.10 }),
    Object.freeze({ move: -0.3, probability: 0.05 }),
  ]),
});

export function analyzeDiscreteDistribution(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0 ||
      outcomes.some((outcome) => !Number.isFinite(outcome.move) ||
        !Number.isFinite(outcome.probability) || outcome.probability < 0)) {
    throw new Error("Distribution outcomes must contain finite moves and non-negative probabilities.");
  }
  const probabilitySum = outcomes.reduce((sum, item) => sum + item.probability, 0);
  const expectedIncrement = outcomes.reduce(
    (sum, item) => sum + item.move * item.probability,
    0,
  );
  const variance = outcomes.reduce(
    (sum, item) => sum + item.probability * (item.move - expectedIncrement) ** 2,
    0,
  );
  return {
    expectedIncrement,
    probabilitySum,
    probabilitiesValid: Math.abs(probabilitySum - 1) <= 1e-12,
    variance,
  };
}

export function multiplierThresholdFromCommissionAmount({
  commissionAmount,
  multiplier,
  stake,
}) {
  if (![commissionAmount, multiplier, stake].every(Number.isFinite) ||
      commissionAmount < 0 || multiplier <= 0 || stake <= 0) {
    throw new Error("Stake, multiplier, and commission amount are invalid.");
  }
  const notional = stake * multiplier;
  const rawReturnFraction = commissionAmount / notional;
  return {
    commissionAmount,
    includedCharges: ["one-off commission amount supplied"],
    multiplier,
    notional,
    rawReturnBps: rawReturnFraction * 10_000,
    rawReturnFraction,
    rawReturnPercent: rawReturnFraction * 100,
    stake,
    unsupportedOrExcluded: [
      "close-price or bid/ask effect",
      "slippage and processing delay",
      "stop-out path and stake cap",
      "optional deal-cancellation charge",
      "quote expiry or rejection",
    ],
  };
}

export function commissionAmountFromPercentOfNotional({
  commissionPercent,
  multiplier,
  stake,
}) {
  if (!Number.isFinite(commissionPercent) || commissionPercent < 0) {
    throw new Error("Commission percent is invalid.");
  }
  return stake * multiplier * commissionPercent / 100;
}

export function buildFeasibilityCalculations() {
  const monetaryInterpretation = multiplierThresholdFromCommissionAmount({
    commissionAmount: 0.02,
    multiplier: 400,
    stake: 1,
  });
  const percentInterpretationAmount = commissionAmountFromPercentOfNotional({
    commissionPercent: 0.02,
    multiplier: 400,
    stake: 1,
  });
  return {
    multiplierQuote: {
      monetaryCommissionInterpretation: monetaryInterpretation,
      percentOfNotionalInterpretation: {
        commissionPercent: 0.02,
        ...multiplierThresholdFromCommissionAmount({
          commissionAmount: percentInterpretationAmount,
          multiplier: 400,
          stake: 1,
        }),
      },
      unitFinding: "Official KID examples express commission charged in account currency, while the current proposal response schema describes its commission field as percentage; 0.5 bp is conditional on treating the observed 0.02 as USD 0.02.",
    },
    skewStep: Object.fromEntries(Object.entries(SKEW_STEP_DISTRIBUTIONS)
      .map(([name, distribution]) => [name, {
        analysis: analyzeDiscreteDistribution(distribution),
        distribution,
      }])),
  };
}
