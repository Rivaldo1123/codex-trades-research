import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fetchGapContext,
  parseGapRepairArgs,
  repairHistoricalGap,
  selectRecoveredTicks,
} from "../src/historical-gap-repair-cli.js";
import { appendTickChunk, loadArchivedTicks, readManifest } from "../src/data-store.js";
import { PUBLIC_ENDPOINT } from "../src/deriv-public.js";

const symbol = "1HZ100V";
const completeTicks = Array.from({ length: 10 }, (_, index) => ({
  epoch: 100 + index,
  quote: 500 + index / 100,
}));
const archivedTicks = completeTicks.filter((tick) => tick.epoch !== 105 && tick.epoch !== 106);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-trades-gap-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marketDirectory = path.join(root, "data", "market");
  await mkdir(marketDirectory, { recursive: true });
  await writeFile(path.join(root, "config.data.json"), JSON.stringify({
    mode: "public-data-only",
    endpoint: PUBLIC_ENDPOINT,
    symbol,
  }));
  // This single chunk's first/last epochs look continuous, but two interior rows are absent.
  await appendTickChunk(root, symbol, archivedTicks);
  await writeFile(path.join(marketDirectory, "historical-backfill-status.json"), JSON.stringify({
    state: "INCOMPLETE",
    symbol,
    endpoint: PUBLIC_ENDPOINT,
    fromEpoch: 100,
    toEpochExclusive: 110,
    pagesFetched: 1,
    rowsStored: 8,
  }));
  return { root, marketDirectory };
}

function fakeClient(ticks = completeTicks) {
  const calls = [];
  return {
    endpoint: PUBLIC_ENDPOINT,
    calls,
    async connect() { calls.push("connect"); },
    async getTicksHistory(requestedSymbol, options) {
      calls.push({ requestedSymbol, options });
      return ticks;
    },
    close() { calls.push("close"); },
  };
}

function repairOptions(root, client) {
  return {
    projectRoot: root,
    client,
    symbol,
    fromEpoch: 100,
    toEpochExclusive: 110,
    missingFromEpoch: 105,
    missingToEpoch: 106,
    expectedRows: 10,
    fetchOptions: { retryDelayMs: 0, wait: async () => {} },
  };
}

test("CLI is locked to the declared 30-day symbol and window", () => {
  const args = [
    "--symbol", "1HZ100V",
    "--from", "1788667200",
    "--to", "1791259200",
    "--missing-from", "1789085201",
    "--missing-to", "1789085207",
  ];
  assert.deepEqual(parseGapRepairArgs(args), {
    symbol: "1HZ100V",
    fromEpoch: 1788667200,
    toEpochExclusive: 1791259200,
    missingFromEpoch: 1789085201,
    missingToEpoch: 1789085207,
  });
  assert.throws(() => parseGapRepairArgs(args.map((value) => value === "1HZ100V" ? "R_100" : value)), /Safety lock/);
  assert.throws(() => parseGapRepairArgs([...args, "--from", "1"]), /Usage/);
});

test("only absent interior ticks are selected after archived context agrees", () => {
  assert.deepEqual(
    selectRecoveredTicks(archivedTicks, completeTicks, {
      missingFromEpoch: 105,
      missingToEpoch: 106,
    }),
    completeTicks.filter((tick) => tick.epoch === 105 || tick.epoch === 106),
  );
  assert.throws(
    () => selectRecoveredTicks(archivedTicks, completeTicks.filter((tick) => tick.epoch !== 106), {
      missingFromEpoch: 105,
      missingToEpoch: 106,
    }),
    /still omits 1 required tick/,
  );
  assert.throws(
    () => selectRecoveredTicks(archivedTicks, completeTicks.map((tick) => tick.epoch === 108 ? { ...tick, quote: 999 } : tick), {
      missingFromEpoch: 105,
      missingToEpoch: 106,
    }),
    /conflicts with archived quote/,
  );
});

test("public context fetch has a finite retry budget", async () => {
  let attempts = 0;
  const client = {
    async connect() {},
    async getTicksHistory() {
      attempts += 1;
      throw new Error("Deriv API error RateLimit: retry later");
    },
  };
  await assert.rejects(
    fetchGapContext(client, symbol, 100, 109, { maxAttempts: 3, retryDelayMs: 0, wait: async () => {} }),
    /failed after 3 attempt/,
  );
  assert.equal(attempts, 3);
});

test("one-shot repair appends only verified missing rows and completes the full audit", async (t) => {
  const { root, marketDirectory } = await fixture(t);
  const client = fakeClient();
  const result = await repairHistoricalGap(repairOptions(root, client));
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.repair.rowsAdded, 2);
  assert.deepEqual(await loadArchivedTicks(root, symbol), completeTicks);
  assert.equal((await readManifest(root, symbol)).chunks.length, 2);
  const status = JSON.parse(await readFile(path.join(marketDirectory, "historical-backfill-status.json"), "utf8"));
  assert.deepEqual(status.audit, {
    availableRows: 10,
    expectedRows: 10,
    firstMissingRanges: [],
    missingRows: 0,
  });
  assert.equal(status.state, "COMPLETED");
  assert.equal(status.pagesFetched, 1);
  assert.deepEqual(client.calls[1], {
    requestedSymbol: symbol,
    options: { count: 1000, start: 100, end: 109 },
  });
  await assert.rejects(readFile(path.join(marketDirectory, "collector.lock")), /ENOENT/);
});

test("a source gap fails closed without modifying the archive or completion status", async (t) => {
  const { root, marketDirectory } = await fixture(t);
  const client = fakeClient(completeTicks.filter((tick) => tick.epoch !== 106));
  await assert.rejects(repairHistoricalGap(repairOptions(root, client)), /still omits 1 required tick/);
  assert.deepEqual(await loadArchivedTicks(root, symbol), archivedTicks);
  assert.equal((await readManifest(root, symbol)).chunks.length, 1);
  const status = JSON.parse(await readFile(path.join(marketDirectory, "historical-backfill-status.json"), "utf8"));
  const repairStatus = JSON.parse(await readFile(path.join(marketDirectory, "historical-gap-repair-status.json"), "utf8"));
  assert.equal(status.state, "INCOMPLETE");
  assert.equal(repairStatus.state, "FAILED");
  await assert.rejects(readFile(path.join(marketDirectory, "collector.lock")), /ENOENT/);
});

test("changed safety configuration prevents even a public history request", async (t) => {
  const { root, marketDirectory } = await fixture(t);
  await writeFile(path.join(root, "config.data.json"), JSON.stringify({
    mode: "demo",
    endpoint: PUBLIC_ENDPOINT,
    symbol,
  }));
  const client = fakeClient();
  await assert.rejects(repairHistoricalGap(repairOptions(root, client)), /Safety lock/);
  assert.deepEqual(client.calls, []);
  await assert.rejects(readFile(path.join(marketDirectory, "collector.lock")), /ENOENT/);
});
