import { setTimeout as delay } from "node:timers/promises";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  appendTickChunk,
  loadArchivedTicks,
  readManifest,
  summarizeManifest,
} from "./data-store.js";
import { auditHistoricalWindow, validateHistoricalPage } from "./historical-backfill-cli.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = Object.freeze({
  symbol: "1HZ100V",
  fromEpoch: 1788667200,
  toEpochExclusive: 1791259200,
  expectedRows: 2_592_000,
});
const CONTEXT_SECONDS = 20;
const MAX_ATTEMPTS = 3;

export function parseGapRepairArgs(args) {
  const names = new Set(["--symbol", "--from", "--to", "--missing-from", "--missing-to"]);
  const values = new Map();
  if (args.length !== names.size * 2) {
    throw new Error("Usage: historical-gap-repair-cli.js --symbol 1HZ100V --from 1788667200 --to 1791259200 --missing-from EPOCH --missing-to EPOCH");
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!names.has(args[index]) || values.has(args[index])) {
      throw new Error("Duplicate or unsupported historical gap repair argument.");
    }
    values.set(args[index], args[index + 1]);
  }
  const symbol = values.get("--symbol");
  const fromEpoch = Number(values.get("--from"));
  const toEpochExclusive = Number(values.get("--to"));
  const missingFromEpoch = Number(values.get("--missing-from"));
  const missingToEpoch = Number(values.get("--missing-to"));
  if (
    symbol !== TARGET.symbol ||
    fromEpoch !== TARGET.fromEpoch ||
    toEpochExclusive !== TARGET.toEpochExclusive ||
    !Number.isSafeInteger(missingFromEpoch) ||
    !Number.isSafeInteger(missingToEpoch) ||
    missingFromEpoch <= fromEpoch ||
    missingToEpoch >= toEpochExclusive - 1 ||
    missingToEpoch < missingFromEpoch ||
    missingToEpoch - missingFromEpoch + 1 > 1000
  ) {
    throw new Error("Safety lock: repair must target a bounded interior gap in the exact 30-day 1HZ100V window.");
  }
  return { symbol, fromEpoch, toEpochExclusive, missingFromEpoch, missingToEpoch };
}

function isTransient(error) {
  return /RateLimit|rate\s*limit|timed out|could not connect|WebSocket closed|Connect to Deriv/i.test(
    error?.message ?? "",
  );
}

export async function fetchGapContext(
  client,
  symbol,
  contextStart,
  contextEnd,
  { maxAttempts = MAX_ATTEMPTS, retryDelayMs = 5_000, wait = delay } = {},
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Gap repair retry budget must be between one and five attempts.");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.connect();
      const ticks = await client.getTicksHistory(symbol, {
        count: 1000,
        start: contextStart,
        end: contextEnd,
      });
      validateHistoricalPage(ticks, contextStart, contextEnd);
      return ticks;
    } catch (error) {
      if (!isTransient(error) || attempt === maxAttempts) {
        throw new Error(`Public gap request failed after ${attempt} attempt(s): ${error.message}`);
      }
      await wait(Math.min(30_000, retryDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw new Error("Public gap request exhausted its retry budget.");
}

export function selectRecoveredTicks(
  archivedContext,
  fetchedTicks,
  { missingFromEpoch, missingToEpoch },
) {
  const archived = new Map(archivedContext.map((tick) => [tick.epoch, tick.quote]));
  const fetched = new Map(fetchedTicks.map((tick) => [tick.epoch, tick.quote]));
  for (const anchor of [missingFromEpoch - 1, missingToEpoch + 1]) {
    if (!archived.has(anchor) || fetched.get(anchor) !== archived.get(anchor)) {
      throw new Error(`Public history did not confirm archived boundary tick ${anchor}.`);
    }
  }
  const recovered = [];
  for (const tick of fetchedTicks) {
    if (archived.has(tick.epoch)) {
      if (archived.get(tick.epoch) !== tick.quote) {
        throw new Error(`Public history conflicts with archived quote at epoch ${tick.epoch}.`);
      }
    } else if (tick.epoch >= missingFromEpoch && tick.epoch <= missingToEpoch) {
      recovered.push(tick);
    } else {
      throw new Error(`Unexpected unarchived context tick ${tick.epoch} outside the declared gap.`);
    }
  }
  const stillMissing = [];
  for (let epoch = missingFromEpoch; epoch <= missingToEpoch; epoch += 1) {
    if (!archived.has(epoch) && !fetched.has(epoch)) stillMissing.push(epoch);
  }
  if (stillMissing.length > 0) {
    throw new Error(`Public history still omits ${stillMissing.length} required tick(s), starting at ${stillMissing[0]}; archive left unchanged.`);
  }
  return recovered;
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await rename(temporary, target);
}

async function acquireLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Collector lock exists; repair will not run alongside a collector.");
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await unlink(lockPath);
  };
}

export async function repairHistoricalGap({
  projectRoot: root,
  client,
  symbol,
  fromEpoch,
  toEpochExclusive,
  missingFromEpoch,
  missingToEpoch,
  expectedRows,
  fetchOptions,
}) {
  if (
    !root || client?.endpoint !== PUBLIC_ENDPOINT ||
    !/^[A-Za-z0-9_]{2,30}$/.test(symbol) ||
    !Number.isSafeInteger(fromEpoch) ||
    !Number.isSafeInteger(toEpochExclusive) ||
    !Number.isSafeInteger(expectedRows) ||
    toEpochExclusive - fromEpoch !== expectedRows ||
    !Number.isSafeInteger(missingFromEpoch) ||
    !Number.isSafeInteger(missingToEpoch) ||
    missingFromEpoch <= fromEpoch ||
    missingToEpoch >= toEpochExclusive - 1 ||
    missingToEpoch < missingFromEpoch ||
    missingToEpoch - missingFromEpoch + 1 > 1000
  ) {
    throw new Error("Safety lock: invalid bounded public-only gap repair request.");
  }

  const marketDirectory = path.join(root, "data", "market");
  const statusPath = path.join(marketDirectory, "historical-backfill-status.json");
  const repairStatusPath = path.join(marketDirectory, "historical-gap-repair-status.json");
  const lockPath = path.join(marketDirectory, "collector.lock");
  const config = JSON.parse(await readFile(path.join(root, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT || config.symbol !== symbol) {
    throw new Error("Safety lock: repair requires the configured public-data-only symbol and endpoint.");
  }
  await mkdir(marketDirectory, { recursive: true });
  const release = await acquireLock(lockPath);
  let repairStatus = {
    state: "RUNNING",
    pid: process.pid,
    symbol,
    endpoint: PUBLIC_ENDPOINT,
    fromEpoch,
    toEpochExclusive,
    missingFromEpoch,
    missingToEpoch,
  };
  try {
    const backfillStatus = JSON.parse(await readFile(statusPath, "utf8"));
    if (
      backfillStatus.state !== "INCOMPLETE" ||
      backfillStatus.symbol !== symbol ||
      backfillStatus.endpoint !== PUBLIC_ENDPOINT ||
      backfillStatus.fromEpoch !== fromEpoch ||
      backfillStatus.toEpochExclusive !== toEpochExclusive
    ) {
      throw new Error("Repair requires an INCOMPLETE backfill status for the same exact public-data window.");
    }
    await writeJsonAtomic(repairStatusPath, repairStatus);

    // A full load checks every immutable chunk hash and detects conflicting quotes.
    const archivedTicks = await loadArchivedTicks(root, symbol);
    const preAudit = auditHistoricalWindow(archivedTicks, fromEpoch, toEpochExclusive);
    if (preAudit.expectedRows !== expectedRows) {
      throw new Error("Historical audit expected-row count does not match the requested window.");
    }
    const contextStart = Math.max(fromEpoch, missingFromEpoch - CONTEXT_SECONDS);
    const contextEnd = Math.min(toEpochExclusive - 1, missingToEpoch + CONTEXT_SECONDS);
    const archivedContext = archivedTicks.filter(
      (tick) => tick.epoch >= contextStart && tick.epoch <= contextEnd,
    );
    const archivedContextEpochs = new Set(archivedContext.map((tick) => tick.epoch));
    let gapMissingRows = 0;
    for (let epoch = missingFromEpoch; epoch <= missingToEpoch; epoch += 1) {
      if (!archivedContextEpochs.has(epoch)) gapMissingRows += 1;
    }
    if (preAudit.missingRows !== gapMissingRows) {
      throw new Error("Archive has missing ticks outside the declared repair range; no data changed.");
    }

    let rowsAdded = 0;
    if (gapMissingRows > 0) {
      const fetchedTicks = await fetchGapContext(
        client, symbol, contextStart, contextEnd, fetchOptions,
      );
      const recovered = selectRecoveredTicks(
        archivedContext, fetchedTicks, { missingFromEpoch, missingToEpoch },
      );
      if (recovered.length !== gapMissingRows) {
        throw new Error("Recovered-tick count does not match the audited gap; no data changed.");
      }
      await appendTickChunk(root, symbol, recovered);
      rowsAdded = recovered.length;
    }

    const verifiedTicks = await loadArchivedTicks(root, symbol);
    const audit = auditHistoricalWindow(verifiedTicks, fromEpoch, toEpochExclusive);
    if (
      audit.expectedRows !== expectedRows ||
      audit.availableRows !== expectedRows ||
      audit.missingRows !== 0 ||
      audit.firstMissingRanges.length !== 0
    ) {
      throw new Error("Post-repair full-window audit is incomplete; backfill status remains INCOMPLETE.");
    }
    const archive = summarizeManifest(await readManifest(root, symbol));
    const repair = {
      missingFromEpoch,
      missingToEpoch,
      contextStart,
      contextEnd,
      rowsAdded,
      source: "Deriv public ticks_history",
    };
    await writeJsonAtomic(statusPath, {
      ...backfillStatus,
      state: "COMPLETED",
      lastError: null,
      archive,
      audit,
      repair,
    });
    repairStatus = { ...repairStatus, state: "COMPLETED", audit, repair };
    await writeJsonAtomic(repairStatusPath, repairStatus);
    return repairStatus;
  } catch (error) {
    repairStatus = { ...repairStatus, state: "FAILED", lastError: error.message };
    await writeJsonAtomic(repairStatusPath, repairStatus);
    throw error;
  } finally {
    client.close?.();
    await release();
  }
}

async function main() {
  const args = parseGapRepairArgs(process.argv.slice(2));
  const client = new DerivPublicClient(PUBLIC_ENDPOINT);
  const result = await repairHistoricalGap({
    projectRoot,
    client,
    ...args,
    expectedRows: TARGET.expectedRows,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
