import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSearchFeatureCache,
  evaluateSearchConfiguration,
  oneSidedStudentTPValue,
} from "../src/strategy-search-engine.js";

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
