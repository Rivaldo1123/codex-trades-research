import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  appendTickChunk,
  filterUncoveredTicks,
  readManifest,
  summarizeManifest,
} from "./data-store.js";
import { collectTickHistory } from "./data-collector.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";
import {
  isRateLimitError,
  reconnectDelay,
  subscribePublicTicks,
} from "./live-data-collector.js";
import { liveRunPolicy } from "./live-run-policy.js";
import { renameStatusFileWithRetry } from "./atomic-status.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketDirectory = path.join(projectRoot, "data", "market");
const lockPath = path.join(marketDirectory, "collector.lock");
const statusPath = path.join(marketDirectory, "live-collector-status.json");
const MAXIMUM_RUN_MS = 14 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const FLUSH_TICK_TARGET = 300;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function parseUntil(value) {
  const until = new Date(value);
  if (!value || Number.isNaN(until.getTime())) {
    throw new Error("run requires --until followed by an ISO date/time.");
  }
  const remainingMs = until.getTime() - Date.now();
  if (remainingMs <= 0 || remainingMs > MAXIMUM_RUN_MS) {
    throw new Error("--until must be in the future and no more than 14 days away.");
  }
  return until;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function loadConfig() {
  const config = JSON.parse(
    await readFile(path.join(projectRoot, "config.data.json"), "utf8"),
  );
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Safety lock: live collection is public-data-only.");
  }
  return config;
}

async function acquireLock() {
  await mkdir(marketDirectory, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Another public data collector is already running.");
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

async function writeStatus(status) {
  await mkdir(marketDirectory, { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await renameStatusFileWithRetry(temporary, statusPath);
}

async function runNodeCommand(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, script), ...args], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${script} ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
          ),
        );
      }
    });
  });
}

async function finalizeResearch(status, persistStatus) {
  const commands = [
    { script: "src/data-cli.js", args: ["dataset"] },
    { script: "src/data-cli.js", args: ["backtest"] },
    { script: "src/browser-run-gate.js", args: [] },
  ];
  status.finalization = {
    requested: true,
    state: "RUNNING",
    completedCommands: [],
    totalCommands: commands.length,
  };
  status.state = "FINALIZING";
  await persistStatus();
  for (const command of commands) {
    await runNodeCommand(command.script, command.args);
    status.finalization.completedCommands.push(
      [command.script, ...command.args].join(" "),
    );
    await persistStatus();
  }
  status.finalization.state = "COMPLETED";
}

async function run() {
  const config = await loadConfig();
  const until = parseUntil(argumentValue("--until"));
  const finalizeAtEnd = hasFlag("--finalize-research");
  const policy = liveRunPolicy(hasFlag("--forward-only"));
  if (policy.forwardOnly && finalizeAtEnd) {
    throw new Error("Forward-only collection cannot run legacy research finalization.");
  }
  const releaseLock = await acquireLock();
  const controller = new AbortController();
  const startedAt = new Date();
  const startingManifest = await readManifest(projectRoot, config.symbol);
  const status = {
    endpoint: PUBLIC_ENDPOINT,
    mode: "public-data-only",
    collectionMode: policy.forwardOnly ? "forward-only" : "legacy-catchup",
    pid: process.pid,
    symbol: config.symbol,
    startedAt: startedAt.toISOString(),
    endsAt: until.toISOString(),
    state: "STARTING",
    ticksReceived: 0,
    ticksStored: 0,
    chunksStored: 0,
    startupCatchupStored: 0,
    catchups: 0,
    catchupPages: 0,
    catchupFailures: 0,
    reconnects: 0,
    lastTickEpoch: null,
    lastError: null,
    lastWarning: policy.forwardOnly
      ? "Historical catch-up is disabled; use an exact-window audit before treating forward data as complete."
      : null,
    archive: summarizeManifest(startingManifest),
    finalization: {
      requested: finalizeAtEnd,
      state: finalizeAtEnd ? "PENDING" : "NOT_REQUESTED",
    },
    updatedAt: startedAt.toISOString(),
  };
  let buffer = [];
  let flushChain = Promise.resolve();
  let fatalError = null;
  let stoppedBySignal = false;

  const persistStatus = async () => {
    status.updatedAt = new Date().toISOString();
    await writeStatus(status);
  };
  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const manifest = await readManifest(projectRoot, config.symbol);
    const uncovered = filterUncoveredTicks(batch, manifest.chunks);
    let latestManifest = manifest;
    if (uncovered.length > 0) {
      const result = await appendTickChunk(projectRoot, config.symbol, uncovered, {
        source: "Deriv public live tick subscription",
      });
      latestManifest = result.manifest;
      status.ticksStored += uncovered.length;
      status.chunksStored += result.chunk ? 1 : 0;
    }
    status.archive = summarizeManifest(latestManifest);
    await persistStatus();
  };
  const queueFlush = () => {
    flushChain = flushChain.then(flush).catch((error) => {
      fatalError = error;
      controller.abort();
    });
  };
  const collectCatchup = async ({ startup = false } = {}) => {
    const before = summarizeManifest(
      await readManifest(projectRoot, config.symbol),
    );
    const catchupClient = new DerivPublicClient(config.endpoint);
    let result = null;
    try {
      await catchupClient.connect();
      result = await collectTickHistory({
        client: catchupClient,
        config: { ...config, targetHistoryDays: 0 },
        projectRoot,
      });
      if (result.archive.internalGaps.length > 0) {
        throw new Error(
          `Live catch-up exhausted its page budget with ${result.archive.internalGaps.length} internal gap(s) remaining.`,
        );
      }
      status.catchups += 1;
      status.catchupPages += result.pagesFetched;
      status.lastWarning = null;
    } finally {
      catchupClient.close();
      const after = summarizeManifest(
        await readManifest(projectRoot, config.symbol),
      );
      const rowsAdded = Math.max(0, after.totalRows - before.totalRows);
      const chunksAdded = Math.max(0, after.chunks - before.chunks);
      if (startup) status.startupCatchupStored += rowsAdded;
      status.ticksStored += rowsAdded;
      status.chunksStored += chunksAdded;
      status.archive = after;
    }
  };
  const collectCatchupSafely = async (options = {}) => {
    try {
      await collectCatchup(options);
      return true;
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      status.catchupFailures += 1;
      status.lastWarning =
        "Public history catch-up was rate-limited after retries; the live subscription remains active.";
      await persistStatus();
      return false;
    }
  };
  const queueCatchup = () => {
    flushChain = flushChain
      .then(() => collectCatchupSafely())
      .catch((error) => {
        fatalError = error;
        controller.abort();
      });
  };
  const stopForSignal = () => {
    stoppedBySignal = true;
    controller.abort();
  };
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);
  const stopTimer = setTimeout(
    () => controller.abort(),
    Math.max(1, until.getTime() - Date.now()),
  );
  const flushTimer = setInterval(queueFlush, FLUSH_INTERVAL_MS);
  const statusTimer = setInterval(() => {
    flushChain = flushChain.then(persistStatus).catch((error) => {
      fatalError = error;
      controller.abort();
    });
  }, 15_000);

  try {
    if (policy.startupCatchup) {
      await collectCatchupSafely({ startup: true });
    }
    status.state = "RUNNING";
    await persistStatus();
    let reconnectAttempt = 0;
    while (!controller.signal.aborted && !fatalError) {
      let catchupQueuedForConnection = false;
      const shouldCatchUpConnectionGap =
        policy.reconnectCatchup && status.reconnects > 0;
      try {
        await subscribePublicTicks({
          endpoint: config.endpoint,
          signal: controller.signal,
          symbol: config.symbol,
          onTick(tick) {
            status.state = "RUNNING";
            status.lastError = null;
            status.ticksReceived += 1;
            status.lastTickEpoch = tick.epoch;
            buffer.push(tick);
            if (shouldCatchUpConnectionGap && !catchupQueuedForConnection) {
              catchupQueuedForConnection = true;
              queueCatchup();
            }
            if (buffer.length >= FLUSH_TICK_TARGET) queueFlush();
          },
        });
        reconnectAttempt = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        status.state = "RECONNECTING";
        status.lastError = error.message;
        status.reconnects += 1;
        await persistStatus();
        reconnectAttempt += 1;
        await reconnectDelay(reconnectAttempt, controller.signal).catch(() => {});
        status.state = "RUNNING";
      }
    }
    await flushChain;
    if (fatalError) throw fatalError;
    if (policy.shutdownCatchup) {
      await collectCatchupSafely();
    }
    await flush();
    if (fatalError) throw fatalError;
    const manifest = await readManifest(projectRoot, config.symbol);
    status.archive = summarizeManifest(manifest);
    if (policy.requireWholeArchiveContiguous && status.archive.internalGaps.length > 0) {
      throw new Error(
        `Tick archive has ${status.archive.internalGaps.length} internal coverage gap(s).`,
      );
    }
    if (finalizeAtEnd && !stoppedBySignal) {
      await finalizeResearch(status, persistStatus);
    }
    status.state = stoppedBySignal ? "STOPPED" : "COMPLETED";
    status.lastError = null;
    await persistStatus();
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    status.state = "FAILED";
    status.lastError = error.message;
    if (status.finalization?.state === "RUNNING") {
      status.finalization.state = "FAILED";
    }
    await persistStatus().catch(() => {});
    throw error;
  } finally {
    clearTimeout(stopTimer);
    clearInterval(flushTimer);
    clearInterval(statusTimer);
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);
    await releaseLock();
  }
}

async function status() {
  console.log(await readFile(statusPath, "utf8"));
}

const command = process.argv[2] ?? "status";
const operation = command === "run" ? run() : command === "status" ? status() : null;
if (!operation) {
  console.error(`Unknown live-data command: ${command}`);
  process.exitCode = 1;
} else {
  operation.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
