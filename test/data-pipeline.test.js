import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendTickChunk,
  filterUncoveredTicks,
  loadArchivedTicks,
  readManifest,
  summarizeManifest,
} from "../src/data-store.js";
import { collectTickHistory } from "../src/data-collector.js";
import { createPurgedSplitPlan, splitForTickIndex } from "../src/dataset.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "../src/deriv-public.js";
import { runPurgedSmaBacktest } from "../src/tick-backtest.js";

test("tick-history responses are normalized and sorted", async () => {
  const client = new DerivPublicClient(PUBLIC_ENDPOINT);
  client.socket = { readyState: WebSocket.OPEN };
  client.request = async () => ({
    history: { prices: [102.5, 101.5], times: [2, 1] },
    msg_type: "history",
  });
  assert.deepEqual(await client.getTicksHistory("1HZ100V", { count: 2 }), [
    { epoch: 1, quote: 101.5 },
    { epoch: 2, quote: 102.5 },
  ]);
});

test("older tick-history pages supply the explicit historical start boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-trades-history-test-"));
  const calls = [];
  const client = {
    async getTicksHistory(_symbol, options) {
      calls.push(options);
      return calls.length === 1
        ? [{ epoch: 200_000, quote: 100 }]
        : [{ epoch: 199_999, quote: 101 }];
    },
  };
  try {
    await collectTickHistory({
      client,
      projectRoot: root,
      config: {
        symbol: "1HZ100V",
        pageSize: 1000,
        requestDelayMs: 0,
        historyPagesPerRun: 2,
        targetHistoryDays: 1,
      },
    });
    assert.equal(calls[0].start, undefined);
    assert.equal(calls[1].start, 113_600);
    assert.equal(calls[1].end, 199_999);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable tick chunks round-trip with checksums and no overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-trades-test-"));
  try {
    await appendTickChunk(
      root,
      "1HZ100V",
      [
        { epoch: 1, quote: 100 },
        { epoch: 2, quote: 101 },
      ],
      {
        request: { startEpochInclusive: 1, endEpochInclusive: 2, count: 2 },
        retrievedAt: "2026-10-08T00:00:00.000Z",
      },
    );
    let manifest = await readManifest(root, "1HZ100V");
    assert.deepEqual(manifest.chunks[0].request, {
      startEpochInclusive: 1,
      endEpochInclusive: 2,
      count: 2,
    });
    assert.equal(manifest.chunks[0].retrievedAt, "2026-10-08T00:00:00.000Z");
    const uncovered = filterUncoveredTicks(
      [
        { epoch: 2, quote: 101 },
        { epoch: 3, quote: 102 },
      ],
      manifest.chunks,
    );
    assert.deepEqual(uncovered, [{ epoch: 3, quote: 102 }]);
    await appendTickChunk(root, "1HZ100V", uncovered);
    manifest = await readManifest(root, "1HZ100V");
    assert.equal(summarizeManifest(manifest).totalRows, 3);
    assert.deepEqual(await loadArchivedTicks(root, "1HZ100V"), [
      { epoch: 1, quote: 100 },
      { epoch: 2, quote: 101 },
      { epoch: 3, quote: 102 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chronological dataset splits purge labels that cross boundaries", () => {
  const plan = createPurgedSplitPlan(1000, {
    maxFeatureWindow: 100,
    maxHorizon: 10,
  });
  assert.equal(splitForTickIndex(plan.trainBoundary - 11, plan), "train");
  assert.equal(splitForTickIndex(plan.trainBoundary - 10, plan), null);
  assert.equal(splitForTickIndex(plan.trainBoundary, plan), "validation");
  assert.equal(splitForTickIndex(plan.validationBoundary - 10, plan), null);
  assert.equal(splitForTickIndex(plan.validationBoundary, plan), "test");
});

test("tick backtest selects on validation and reports an untouched test", () => {
  const ticks = Array.from({ length: 2000 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: 100 + index * 0.001 + Math.sin(index / 30),
  }));
  const report = runPurgedSmaBacktest(ticks, {
    backtestFastWindows: [5, 10],
    backtestSlowWindows: [20, 50],
    horizonsTicks: [5],
  });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].candidateCount, 4);
  assert.ok(report.results[0].validation.observations > 0);
  assert.ok(report.results[0].test.observations > 0);
});
