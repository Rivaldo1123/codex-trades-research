import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateSearchProtocol(protocol) {
  if (
    protocol?.schemaVersion !== 1 ||
    protocol.batchId !== "development-screen-v1" ||
    protocol.status !== "FROZEN_BEFORE_MAIN_SEARCH" ||
    protocol.dataset?.source !== "Deriv public ticks_history" ||
    protocol.dataset?.authentication !== "none" ||
    protocol.dataset?.symbol !== "1HZ100V" ||
    protocol.dataset?.historicalPricesAreExecutableQuotes !== false ||
    protocol.safety?.fixedNormalizedStake !== 1 ||
    protocol.safety?.martingale !== false ||
    protocol.safety?.ordersAuthorized !== false ||
    protocol.protectedFinalEvaluation?.availableNow !== false
  ) {
    throw new Error("Search protocol identity, data source, or safety lock changed.");
  }
  const quotas = protocol.searchBudget?.families;
  const planned = Object.values(quotas ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (
    planned !== 12_012 ||
    protocol.searchBudget.plannedUniqueConfigurations !== planned ||
    protocol.searchBudget.adaptiveSearch !== false ||
    protocol.parameterRanges?.profitPerDollarOnLossOrTie !== -1 ||
    canonicalJson(protocol.parameterRanges?.entryDelayTicks) !== "[1,2,3]" ||
    canonicalJson(protocol.parameterRanges?.profitPerDollarOnWin) !==
      "[0.7,0.8,0.9]" ||
    protocol.evaluationWindows?.length !== 3 ||
    protocol.acceptanceRules?.familyWiseAlpha !== 0.05 ||
    protocol.acceptanceRules?.maximumFinalShortlist !== 3
  ) {
    throw new Error("Search budget, scenarios, or frozen acceptance rules changed.");
  }
  return protocol;
}

function addCandidate(target, family, parameters) {
  target.push({ family, ...parameters });
}

function enumerateSma(protocol, family) {
  const range = protocol.parameterRanges.sma;
  const candidates = [];
  let invalid = 0;
  for (const fastWindow of range.fastWindows) {
    for (const slowWindow of range.slowWindows) {
      if (fastWindow >= slowWindow) {
        invalid +=
          range.minimumSeparationBps.length *
          protocol.parameterRanges.durationsTicks.length *
          range.volatilityWindows.length *
          range.minimumVolatilityBps.length;
        continue;
      }
      for (const thresholdBps of range.minimumSeparationBps) {
        for (const durationTicks of protocol.parameterRanges.durationsTicks) {
          for (const volatilityWindow of range.volatilityWindows) {
            for (const minimumVolatilityBps of range.minimumVolatilityBps) {
              addCandidate(candidates, family, {
                durationTicks,
                fastWindow,
                minimumVolatilityBps,
                slowWindow,
                thresholdBps,
                volatilityWindow,
              });
            }
          }
        }
      }
    }
  }
  return { candidates, invalid };
}

function enumerateMomentum(protocol, family) {
  const range = protocol.parameterRanges.momentum;
  const candidates = [];
  for (const lookbackTicks of range.lookbackTicks) {
    for (const thresholdBps of range.minimumMoveBps) {
      for (const durationTicks of protocol.parameterRanges.durationsTicks) {
        for (const volatilityWindow of range.volatilityWindows) {
          for (const minimumVolatilityBps of range.minimumVolatilityBps) {
            addCandidate(candidates, family, {
              durationTicks,
              lookbackTicks,
              minimumVolatilityBps,
              thresholdBps,
              volatilityWindow,
            });
          }
        }
      }
    }
  }
  return { candidates, invalid: 0 };
}

function enumerateChannel(protocol) {
  const range = protocol.parameterRanges.channel;
  const candidates = [];
  for (const lookbackTicks of range.lookbackTicks) {
    for (const thresholdBps of range.breakoutBufferBps) {
      for (const durationTicks of protocol.parameterRanges.durationsTicks) {
        for (const volatilityWindow of range.volatilityWindows) {
          for (const minimumVolatilityBps of range.minimumVolatilityBps) {
            addCandidate(candidates, "channel_breakout", {
              durationTicks,
              lookbackTicks,
              minimumVolatilityBps,
              thresholdBps,
              volatilityWindow,
            });
          }
        }
      }
    }
  }
  return { candidates, invalid: 0 };
}

function enumerateZscore(protocol) {
  const range = protocol.parameterRanges.zscore;
  const candidates = [];
  for (const lookbackTicks of range.lookbackTicks) {
    for (const thresholdZ of range.absoluteThreshold) {
      for (const durationTicks of protocol.parameterRanges.durationsTicks) {
        for (const volatilityWindow of range.volatilityWindows) {
          for (const minimumVolatilityBps of range.minimumVolatilityBps) {
            addCandidate(candidates, "zscore_reversion", {
              durationTicks,
              lookbackTicks,
              minimumVolatilityBps,
              thresholdZ,
              volatilityWindow,
            });
          }
        }
      }
    }
  }
  return { candidates, invalid: 0 };
}

function fixedSubset(candidates, quota, seed) {
  if (candidates.length < quota) {
    throw new Error(`Declared grid has only ${candidates.length} candidates for quota ${quota}.`);
  }
  return candidates
    .map((config) => ({
      config,
      order: sha256(`${seed}|${canonicalJson(config)}`),
    }))
    .sort((left, right) => left.order.localeCompare(right.order))
    .slice(0, quota)
    .map((item) => item.config);
}

export function generateFrozenConfigurations(protocolInput) {
  const protocol = validateSearchProtocol(protocolInput);
  const quotas = protocol.searchBudget.families;
  const seed = `${protocol.batchId}|configuration-grid-v1`;
  const configurations = [];
  for (const direction of ["rise", "fall"]) {
    for (const durationTicks of protocol.parameterRanges.durationsTicks) {
      configurations.push({
        direction,
        durationTicks,
        family: "unconditional_baseline",
      });
    }
  }
  const generated = {
    sma_trend: enumerateSma(protocol, "sma_trend"),
    sma_reversion: enumerateSma(protocol, "sma_reversion"),
    momentum_trend: enumerateMomentum(protocol, "momentum_trend"),
    momentum_reversion: enumerateMomentum(protocol, "momentum_reversion"),
    channel_breakout: enumerateChannel(protocol),
    zscore_reversion: enumerateZscore(protocol),
  };
  for (const [family, result] of Object.entries(generated)) {
    configurations.push(
      ...fixedSubset(result.candidates, quotas[family], `${seed}|${family}`),
    );
  }
  const seen = new Set();
  let duplicates = 0;
  const valid = [];
  for (const config of configurations) {
    const configHash = sha256(canonicalJson(config));
    if (seen.has(configHash)) {
      duplicates += 1;
      continue;
    }
    seen.add(configHash);
    valid.push({
      configHash,
      strategyId: `${config.family}:${configHash.slice(0, 16)}`,
      ...config,
    });
  }
  if (valid.length !== protocol.searchBudget.plannedUniqueConfigurations) {
    throw new Error(
      `Frozen generator produced ${valid.length} unique configurations, expected ${protocol.searchBudget.plannedUniqueConfigurations}.`,
    );
  }
  return {
    configurations: valid,
    audit: {
      duplicateConfigurations: duplicates,
      enumeratedBeforeQuota: Object.fromEntries(
        Object.entries(generated).map(([family, result]) => [
          family,
          result.candidates.length,
        ]),
      ),
      invalidGridCombinations: Object.values(generated).reduce(
        (sum, result) => sum + result.invalid,
        0,
      ),
      uniqueConfigurations: valid.length,
    },
  };
}
