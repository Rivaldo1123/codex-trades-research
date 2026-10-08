import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSearchFeatureCache,
  evaluateSearchConfiguration,
  oneSidedStudentTPValue,
} from "../src/strategy-search-engine.js";
import {
  replaySequentialSignals,
  SIGNAL_RISE,
} from "../src/execution-model.js";

const frozen = JSON.parse(
  await readFile(
    new URL("../research/protocols/development-screen-v1.json", import.meta.url),
    "utf8",
  ),
);

function smallProtocol() {
  const protocol = structuredClone(frozen);
  protocol.dataset.fromEpochInclusive = 1_700_000_000;
  protocol.dataset.toEpochExclusive = 1_700_001_200;
  protocol.evaluationWindows = [
    { id: "one", fromEpochInclusive: 1_700_000_000, toEpochExclusive: 1_700_000_400 },
    { id: "two", fromEpochInclusive: 1_700_000_400, toEpochExclusive: 1_700_000_800 },
    { id: "three", fromEpochInclusive: 1_700_000_800, toEpochExclusive: 1_700_001_200 },
  ];
  return protocol;
}

test("day-block Student t tail is centered at one half", () => {
  assert.ok(Math.abs(oneSidedStudentTPValue(0, 29) - 0.5) < 1e-12);
  assert.ok(oneSidedStudentTPValue(3, 29) < 0.01);
  assert.ok(oneSidedStudentTPValue(-3, 29) > 0.99);
});

test("cached search evaluation is causal, sequential, and split bounded", () => {
  const protocol = smallProtocol();
  const slots =
    protocol.dataset.toEpochExclusive - protocol.dataset.fromEpochInclusive;
  const quotes = Float64Array.from(
    { length: slots },
    (_, index) => 100 + index * 0.01,
  );
  const present = new Uint8Array(slots).fill(1);
  const cache = buildSearchFeatureCache({ present, protocol, quotes });
  const evaluation = evaluateSearchConfiguration({
    cache,
    config: {
      configHash: "a".repeat(64),
      direction: "rise",
      durationTicks: 10,
      family: "unconditional_baseline",
      strategyId: "baseline",
    },
    protocol,
  });
  assert.equal(evaluation.base.losses, 0);
  assert.equal(evaluation.base.winRate, 1);
  assert.equal(evaluation.scenarios.length, 27 / 3);
  assert.ok(
    evaluation.scenarios.every((scenario) => scenario.counts.trades <= 7),
  );
});

test("base accounting, drawdown and losing streak match a four-trade fixture", () => {
  const protocol = smallProtocol();
  const fromEpoch = 1_700_000_040;
  protocol.dataset.fromEpochInclusive = fromEpoch;
  protocol.dataset.toEpochExclusive = fromEpoch + 240;
  protocol.evaluationWindows = [{
    fromEpochInclusive: fromEpoch,
    id: "fixture",
    toEpochExclusive: fromEpoch + 240,
  }];
  const quotes = new Float64Array(240).fill(100);
  for (const [decisionOffset, settlement] of [
    [0, 99],
    [60, 99],
    [120, 101],
    [180, 99],
  ]) {
    quotes[decisionOffset + 2] = settlement;
  }
  const evaluation = evaluateSearchConfiguration({
    cache: buildSearchFeatureCache({
      present: new Uint8Array(240).fill(1),
      protocol,
      quotes,
    }),
    config: {
      direction: "rise",
      durationTicks: 1,
      family: "unconditional_baseline",
    },
    protocol,
  });
  assert.deepEqual(
    { losses: evaluation.base.losses, trades: evaluation.base.trades,
      wins: evaluation.base.wins },
    { losses: 3, trades: 4, wins: 1 },
  );
  assert.ok(Math.abs(evaluation.base.netProfit - (-2.1)) < 1e-12);
  assert.ok(Math.abs(evaluation.base.averageProfitPerDollarStaked - (-0.525)) < 1e-12);
  assert.ok(Math.abs(evaluation.base.profitFactor - 0.3) < 1e-12);
  assert.ok(Math.abs(evaluation.drawdown.maximumDrawdownStakeUnits - 2.1) < 1e-12);
  assert.equal(evaluation.drawdown.longestLosingStreak, 2);
});

test("a genuine gap invalidates crossing outcomes instead of inventing prices", () => {
  const protocol = smallProtocol();
  const slots =
    protocol.dataset.toEpochExclusive - protocol.dataset.fromEpochInclusive;
  const quotes = Float64Array.from(
    { length: slots },
    (_, index) => 100 + index * 0.01,
  );
  const complete = new Uint8Array(slots).fill(1);
  const gapped = new Uint8Array(complete);
  gapped[345] = 0;
  const completeEvaluation = evaluateSearchConfiguration({
    cache: buildSearchFeatureCache({ present: complete, protocol, quotes }),
    config: {
      direction: "rise",
      durationTicks: 10,
      family: "unconditional_baseline",
    },
    protocol,
  });
  const gappedEvaluation = evaluateSearchConfiguration({
    cache: buildSearchFeatureCache({ present: gapped, protocol, quotes }),
    config: {
      direction: "rise",
      durationTicks: 10,
      family: "unconditional_baseline",
    },
    protocol,
  });
  assert.ok(gappedEvaluation.base.trades < completeEvaluation.base.trades);
});

test("audit mode exposes complete chronological UTC-day outcome blocks", () => {
  const protocol = smallProtocol();
  const slots =
    protocol.dataset.toEpochExclusive - protocol.dataset.fromEpochInclusive;
  const quotes = Float64Array.from(
    { length: slots },
    (_, index) => 100 + index * 0.01,
  );
  const present = new Uint8Array(slots).fill(1);
  const evaluation = evaluateSearchConfiguration({
    cache: buildSearchFeatureCache({ present, protocol, quotes }),
    captureDayBlocks: true,
    config: {
      direction: "rise",
      durationTicks: 1,
      family: "unconditional_baseline",
    },
    protocol,
  });
  assert.equal(evaluation.uncertainty.utcDayOutcomeBlocks.length, 1);
  const block = evaluation.uncertainty.utcDayOutcomeBlocks[0];
  assert.equal(block.wins + block.losses, block.trades);
});

test("vectorized search outcomes agree with the shared sequential reference", () => {
  const protocol = smallProtocol();
  const slots =
    protocol.dataset.toEpochExclusive - protocol.dataset.fromEpochInclusive;
  const ticks = Array.from({ length: slots }, (_, index) => ({
    epoch: protocol.dataset.fromEpochInclusive + index,
    quote: 100 + Math.sin(index / 9),
  }));
  const quotes = Float64Array.from(ticks, (tick) => tick.quote);
  const present = new Uint8Array(slots).fill(1);
  const evaluation = evaluateSearchConfiguration({
    cache: buildSearchFeatureCache({ present, protocol, quotes }),
    config: {
      direction: "rise",
      durationTicks: 5,
      family: "unconditional_baseline",
    },
    protocol,
  });
  const signals = new Uint8Array(ticks.length);
  for (let index = 0; index < ticks.length; index += 1) {
    if (ticks[index].epoch % 60 === 0) signals[index] = SIGNAL_RISE;
  }
  for (const scenario of evaluation.scenarios) {
    const window = protocol.evaluationWindows.find(
      (candidate) => candidate.id === scenario.windowId,
    );
    const reference = replaySequentialSignals({
      delayTicks: scenario.delayTicks,
      durationTicks: 5,
      fromEpoch: window.fromEpochInclusive,
      signals,
      ticks,
      toEpochExclusive: window.toEpochExclusive,
    });
    assert.deepEqual(scenario.counts, {
      losses: reference.counts.losses,
      ties: reference.counts.ties,
      trades: reference.counts.settledTrades,
      wins: reference.counts.wins,
    });
  }
});
