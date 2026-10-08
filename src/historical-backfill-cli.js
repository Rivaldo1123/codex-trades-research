import { setTimeout as delay } from "node:timers/promises";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  appendTickChunk,
  filterUncoveredTicks,
  loadArchivedTicks,
  readManifest,
  summarizeManifest,
} from "./data-store.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketDirectory = path.join(projectRoot, "data", "market");
const statusPath = path.join(marketDirectory, "historical-backfill-status.json");
const lockPath = path.join(marketDirectory, "collector.lock");
const REQUEST_DELAY_MS = 3_000;
const PAGE_SIZE = 1_000; // The public service currently caps a response at 1,000 ticks.

export function parseBackfillArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--from", "--to", "--max-pages"].includes(key) || value === undefined || values.has(key)) {
      throw new Error("Usage: historical-backfill-cli.js --from EPOCH --to EPOCH [--max-pages N]");
    }
    values.set(key, Number(value));
  }
  const fromEpoch = values.get("--from");
  const toEpochExclusive = values.get("--to");
  const maxPages = values.get("--max-pages") ?? Infinity;
  if (
    !Number.isSafeInteger(fromEpoch) || fromEpoch < 1 ||
    !Number.isSafeInteger(toEpochExclusive) || toEpochExclusive <= fromEpoch ||
    toEpochExclusive > Math.floor(Date.now() / 1000) ||
    !(maxPages === Infinity || (Number.isSafeInteger(maxPages) && maxPages >= 1))
  ) {
    throw new Error("Historical window must be a past half-open Unix epoch range; max-pages must be positive.");
  }
  return { fromEpoch, toEpochExclusive, maxPages };
}

export function nextHistoricalCursor(manifest, fromEpoch, toEpochExclusive) {
  const oldestArchivedEpoch = summarizeManifest(manifest).firstEpoch;
  return oldestArchivedEpoch === null
    ? toEpochExclusive - 1
    : Math.min(toEpochExclusive - 1, oldestArchivedEpoch - 1);
}

export function validateHistoricalPage(ticks, fromEpoch, cursorEpoch) {
  if (!Array.isArray(ticks) || ticks.length === 0) {
    throw new Error(`No historical ticks were returned at or before ${cursorEpoch}.`);
  }
  if (
    ticks.some(
      (tick) =>
        !Number.isSafeInteger(tick.epoch) ||
        !Number.isFinite(tick.quote) ||
        tick.epoch < fromEpoch || tick.epoch > cursorEpoch,
    )
  ) {
    throw new Error("Historical response was outside the requested range or invalid.");
  }
  for (let index = 1; index < ticks.length; index += 1) {
    if (ticks[index].epoch <= ticks[index - 1].epoch) {
      throw new Error("Historical response was not strictly ordered by epoch.");
    }
  }
  return ticks[0].epoch - 1;
}

export function auditHistoricalWindow(ticks, fromEpoch, toEpochExclusive) {
  const windowTicks = ticks.filter(
    (tick) => tick.epoch >= fromEpoch && tick.epoch < toEpochExclusive,
  );
  let index = 0;
  let missingRows = 0;
  const firstMissingRanges = [];
  for (let epoch = fromEpoch; epoch < toEpochExclusive; epoch += 1) {
    while (index < windowTicks.length && windowTicks[index].epoch < epoch) index += 1;
    if (windowTicks[index]?.epoch === epoch) continue;
    missingRows += 1;
    const previous = firstMissingRanges.at(-1);
    if (previous?.lastEpoch === epoch - 1) {
      previous.lastEpoch = epoch;
    } else if (firstMissingRanges.length < 20) {
      firstMissingRanges.push({ firstEpoch: epoch, lastEpoch: epoch });
    }
  }
  return {
    availableRows: windowTicks.length,
    expectedRows: toEpochExclusive - fromEpoch,
    firstMissingRanges,
    missingRows,
  };
}

async function writeStatus(status) {
  await mkdir(marketDirectory, { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await rename(temporary, statusPath);
}

async function acquireLock() {
  await mkdir(marketDirectory, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Collector lock exists; check the other collector before removing data/market/collector.lock.");
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

function isTransient(error) {
  return /RateLimit|rate\s*limit|timed out|could not connect|WebSocket closed|Connect to Deriv/i.test(
    error?.message ?? "",
  );
}

async function fetchHistoricalPage(client, symbol, fromEpoch, cursorEpoch, status, isStopped) {
  let retry = 0;
  for (;;) {
    if (isStopped()) return null;
    try {
      await client.connect();
      return await client.getTicksHistory(symbol, {
        count: PAGE_SIZE,
        end: cursorEpoch,
        start: fromEpoch,
      });
    } catch (error) {
      if (!isTransient(error)) throw error;
      retry += 1;
      const backoffMs = Math.min(300_000, 5_000 * 2 ** Math.min(retry - 1, 6));
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      await writeStatus({
        ...status,
        state: "BACKING_OFF",
        lastError: error.message,
        consecutiveRetries: retry,
        retryAt,
      });
      console.warn(`${error.message} Retrying in ${Math.ceil(backoffMs / 1000)}s.`);
      await delay(backoffMs);
    }
  }
}

async function loadConfig() {
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Safety lock: historical collection requires the public-data-only mode and endpoint.");
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(config.symbol)) {
    throw new Error("Safety lock: invalid historical symbol.");
  }
  return config;
}

async function run() {
  const { fromEpoch, toEpochExclusive, maxPages } = parseBackfillArgs(process.argv.slice(2));
  const config = await loadConfig();
  const release = await acquireLock();
  const client = new DerivPublicClient(config.endpoint);
  let stopRequested = false;
  process.on("SIGINT", () => { stopRequested = true; });
  process.on("SIGTERM", () => { stopRequested = true; });
  let status = {
    state: "STARTING",
    pid: process.pid,
    symbol: config.symbol,
    endpoint: config.endpoint,
    fromEpoch,
    toEpochExclusive,
    pagesFetched: 0,
    rowsStored: 0,
    lastError: null,
  };
  try {
    // Verify all existing chunk hashes before extending the archive.
    await loadArchivedTicks(projectRoot, config.symbol);
    let manifest = await readManifest(projectRoot, config.symbol);
    let cursorEpoch = nextHistoricalCursor(manifest, fromEpoch, toEpochExclusive);
    status = { ...status, state: "RUNNING", cursorEpoch, archive: summarizeManifest(manifest) };
    await writeStatus(status);
    while (cursorEpoch >= fromEpoch && status.pagesFetched < maxPages && !stopRequested) {
      if (status.pagesFetched > 0) await delay(REQUEST_DELAY_MS);
      const ticks = await fetchHistoricalPage(
        client, config.symbol, fromEpoch, cursorEpoch, status, () => stopRequested,
      );
      if (ticks === null) break;
      const nextCursor = validateHistoricalPage(ticks, fromEpoch, cursorEpoch);
      const uncovered = filterUncoveredTicks(ticks, manifest.chunks);
      if (uncovered.length === 0) {
        throw new Error("Historical page made no archive progress.");
      }
      const result = await appendTickChunk(projectRoot, config.symbol, uncovered);
      manifest = result.manifest;
      cursorEpoch = nextCursor;
      status = {
        ...status,
        state: "RUNNING",
        cursorEpoch,
        pagesFetched: status.pagesFetched + 1,
        rowsStored: status.rowsStored + uncovered.length,
        lastPage: { firstEpoch: ticks[0].epoch, lastEpoch: ticks.at(-1).epoch, rows: ticks.length },
        lastError: null,
        archive: summarizeManifest(manifest),
      };
      await writeStatus(status);
      if (status.pagesFetched % 10 === 0) {
        console.log(`Saved ${status.pagesFetched} pages; oldest archived epoch ${status.archive.firstEpoch}.`);
      }
    }
    if (stopRequested || status.pagesFetched >= maxPages && cursorEpoch >= fromEpoch) {
      status = { ...status, state: stopRequested ? "PAUSED" : "PARTIAL", cursorEpoch };
      await writeStatus(status);
      console.log(JSON.stringify(status));
      return;
    }
    const ticks = await loadArchivedTicks(projectRoot, config.symbol);
    const audit = auditHistoricalWindow(ticks, fromEpoch, toEpochExclusive);
    status = {
      ...status,
      state: audit.missingRows === 0 ? "COMPLETED" : "INCOMPLETE",
      cursorEpoch,
      audit,
    };
    await writeStatus(status);
    console.log(JSON.stringify(status));
    if (audit.missingRows > 0) process.exitCode = 2;
  } catch (error) {
    status = { ...status, state: "FAILED", lastError: error.message };
    await writeStatus(status);
    throw error;
  } finally {
    client.close();
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
