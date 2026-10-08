import assert from "node:assert/strict";
import test from "node:test";

import { DerivPublicClient } from "../src/deriv-public.js";
import {
  MAX_HISTORICAL_RETRIES,
  auditHistoricalWindow,
  historicalBackoffMs,
  nextHistoricalCursor,
  parseBackfillArgs,
  validateHistoricalPage,
} from "../src/historical-backfill-cli.js";

test("historical retry schedule is finite and capped", () => {
  assert.equal(MAX_HISTORICAL_RETRIES, 8);
  assert.equal(historicalBackoffMs(1), 5_000);
  assert.equal(historicalBackoffMs(8), 300_000);
  assert.throws(() => historicalBackoffMs(0), /positive integer/);
});

test("historical arguments require a bounded past epoch window", () => {
  assert.deepEqual(parseBackfillArgs(["--from", "100", "--to", "200"]), {
    fromEpoch: 100,
    toEpochExclusive: 200,
    maxPages: Infinity,
  });
  assert.throws(() => parseBackfillArgs(["--from", "200", "--to", "100"]), /Historical window/);
  assert.throws(() => parseBackfillArgs(["--from", "100", "--to", "200", "--from", "1"]), /Usage/);
});

test("backfill resumes immediately before the earliest archived tick", () => {
  const manifest = {
    chunks: [{ firstEpoch: 160, lastEpoch: 250, rows: 91 }],
  };
  assert.equal(nextHistoricalCursor(manifest, 100, 200), 159);
  assert.equal(nextHistoricalCursor({ chunks: [] }, 100, 200), 199);
});

test("historical pages are bounded and strictly ordered", () => {
  assert.equal(validateHistoricalPage([{ epoch: 100, quote: 1 }, { epoch: 101, quote: 2 }], 100, 101), 99);
  assert.throws(() => validateHistoricalPage([{ epoch: 102, quote: 1 }], 100, 101), /outside/);
  assert.throws(() => validateHistoricalPage([{ epoch: 101, quote: 1 }, { epoch: 100, quote: 2 }], 100, 101), /ordered/);
  assert.throws(() => validateHistoricalPage([], 100, 101), /No historical/);
});

test("row-level audit detects missing seconds hidden by chunk ranges", () => {
  assert.deepEqual(
    auditHistoricalWindow(
      [{ epoch: 99, quote: 1 }, { epoch: 100, quote: 1 }, { epoch: 102, quote: 2 }, { epoch: 105, quote: 3 }],
      100,
      105,
    ),
    {
      availableRows: 2,
      expectedRows: 5,
      firstMissingRanges: [
        { firstEpoch: 101, lastEpoch: 101 },
        { firstEpoch: 103, lastEpoch: 104 },
      ],
      missingRows: 3,
    },
  );
});

test("public client stringifies end and rejects an out-of-range response", async () => {
  const client = new DerivPublicClient();
  let payload;
  client.request = async (request) => {
    payload = request;
    return { history: { prices: [1], times: [201] } };
  };
  await assert.rejects(
    client.getTicksHistory("1HZ100V", { count: 1, start: 100, end: 200 }),
    /outside the requested historical range/,
  );
  assert.equal(payload.end, "200");
  assert.equal(payload.start, 100);
});
