function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function simpleMovingAverage(values, window) {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error("Moving-average window must be a positive integer.");
  }

  const result = Array(values.length).fill(null);
  let rollingSum = 0;

  for (let index = 0; index < values.length; index += 1) {
    rollingSum += values[index];
    if (index >= window) {
      rollingSum -= values[index - window];
    }
    if (index >= window - 1) {
      result[index] = rollingSum / window;
    }
  }

  return result;
}

export function buildSignals(candles, fastWindow, slowWindow) {
  if (fastWindow >= slowWindow) {
    throw new Error("The fast window must be smaller than the slow window.");
  }

  const closes = candles.map((candle) => candle.close);
  const fast = simpleMovingAverage(closes, fastWindow);
  const slow = simpleMovingAverage(closes, slowWindow);

  return candles.map((candle, index) => {
    let signal = "wait";
    if (fast[index] !== null && slow[index] !== null) {
      signal = fast[index] > slow[index] ? "up" : "down";
    }

    return {
      close: candle.close,
      epoch: candle.epoch,
      fast: fast[index],
      signal,
      slow: slow[index],
    };
  });
}

function evaluateDirectionalSignals(signals) {
  const observations = [];

  for (let index = 0; index < signals.length - 1; index += 1) {
    const current = signals[index];
    const next = signals[index + 1];
    if (current.signal === "wait" || current.close === 0) {
      continue;
    }

    const marketReturn = (next.close - current.close) / current.close;
    const signedReturn = current.signal === "up" ? marketReturn : -marketReturn;
    observations.push(signedReturn);
  }

  const wins = observations.filter((value) => value > 0).length;
  const losses = observations.filter((value) => value < 0).length;

  return {
    averageSignedReturn: mean(observations),
    observations: observations.length,
    positiveRate:
      observations.length === 0 ? null : wins / observations.length,
    wins,
    losses,
  };
}

export function createResearchReport(candles, config) {
  if (candles.length < config.slowWindow + 20) {
    throw new Error("Not enough candles to evaluate the configured baseline.");
  }

  const splitIndex = Math.floor(candles.length * 0.7);
  const training = candles.slice(0, splitIndex);
  const testing = candles.slice(splitIndex - config.slowWindow);
  const trainingSignals = buildSignals(
    training,
    config.fastWindow,
    config.slowWindow,
  );
  const testingSignals = buildSignals(
    testing,
    config.fastWindow,
    config.slowWindow,
  ).slice(config.slowWindow);

  const latest = buildSignals(
    candles,
    config.fastWindow,
    config.slowWindow,
  ).at(-1);

  return {
    disclaimer:
      "Research signal only. This is not a trade instruction or evidence of future profit.",
    generatedAt: new Date().toISOString(),
    input: {
      candles: candles.length,
      fastWindow: config.fastWindow,
      firstEpoch: candles[0].epoch,
      lastEpoch: candles.at(-1).epoch,
      slowWindow: config.slowWindow,
    },
    latestSignal: latest,
    methodology: {
      evaluation:
        "Each signal is checked against the direction of the next candle only.",
      split: "Chronological 70% training / 30% testing",
      strategy: "Simple moving-average direction baseline",
    },
    testing: evaluateDirectionalSignals(testingSignals),
    training: evaluateDirectionalSignals(trainingSignals),
  };
}
