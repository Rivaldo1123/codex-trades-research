import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { collectTickHistory } from "./data-collector.js";
import { loadArchivedTicks, readManifest, summarizeManifest } from "./data-store.js";
import { writeTrainingDataset } from "./dataset.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";
import { writeBacktestReport } from "./tick-backtest.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfig() {
  const config = JSON.parse(
    await readFile(path.join(projectRoot, "config.data.json"), "utf8"),
  );
  if (config.mode !== "public-data-only") {
    throw new Error("Safety lock: data mode must remain public-data-only.");
  }
  if (config.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Safety lock: data collection must use the public endpoint.");
  }
  if (!Number.isInteger(config.historyPagesPerRun) || config.historyPagesPerRun < 1) {
    throw new Error("historyPagesPerRun must be a positive integer.");
  }
  return config;
}

async function acquireCollectorLock() {
  const lockPath = path.join(projectRoot, "data", "market", "collector.lock");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(lockPath), { recursive: true }),
  );
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Another data collector appears active. Remove data/market/collector.lock only after confirming no collector is running.",
      );
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`, "utf8");
  return async () => {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

async function collect(config) {
  const release = await acquireCollectorLock();
  const client = new DerivPublicClient(config.endpoint);
  try {
    await client.connect();
    const result = await collectTickHistory({ client, config, projectRoot });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    client.close();
    await release();
  }
}

async function status(config) {
  const manifest = await readManifest(projectRoot, config.symbol);
  const result = { symbol: config.symbol, ...summarizeManifest(manifest) };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function dataset(config) {
  const ticks = await loadArchivedTicks(projectRoot, config.symbol, {
    maxRows: config.maxDatasetTicks,
  });
  const result = await writeTrainingDataset({ config, projectRoot, ticks });
  console.log(
    JSON.stringify(
      { directory: result.directory, ...result.metadata.rowCounts },
      null,
      2,
    ),
  );
  return result;
}

async function backtest(config) {
  const ticks = await loadArchivedTicks(projectRoot, config.symbol, {
    maxRows: config.maxDatasetTicks,
  });
  const result = await writeBacktestReport({ config, projectRoot, ticks });
  const fiveTick = result.report.results.find((item) => item.selected.horizonTicks === 5);
  console.log(
    JSON.stringify(
      { fiveTick, reportPath: result.reportPath, ticks: ticks.length },
      null,
      2,
    ),
  );
  return result;
}

async function main() {
  const command = process.argv[2] ?? "status";
  const config = await loadConfig();
  if (command === "collect") return collect(config);
  if (command === "status") return status(config);
  if (command === "dataset") return dataset(config);
  if (command === "backtest") return backtest(config);
  if (command === "pipeline") {
    await collect(config);
    await dataset(config);
    return backtest(config);
  }
  throw new Error(`Unknown data command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
