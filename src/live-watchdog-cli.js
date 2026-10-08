import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";
import { renameStatusFileWithRetry } from "./atomic-status.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketDirectory = path.join(projectRoot, "data", "market");
const configPath = path.join(projectRoot, "config.data.json");
const collectorStatusPath = path.join(marketDirectory, "live-collector-status.json");
const lockPath = path.join(marketDirectory, "collector.lock");
const watchdogStatusPath = path.join(marketDirectory, "live-watchdog-status.json");
const defaultProtocol = "data/market/forward-protocol-2026-10-07.json";

export const WATCHDOG_LIMITS = Object.freeze({
  pollMs: 30_000,
  startupGraceMs: 15 * 60_000,
  staleStatusMs: 90_000,
  noProgressMs: 10 * 60_000,
  finishGraceMs: 20 * 60_000,
});

export function parseWatchdogArgs(args) {
  if (args[0] !== "run" || ![7, 9, 11].includes(args.length)) {
    throw new Error("Usage: node src/live-watchdog-cli.js run --pid PID --until ISO_TIME --symbol SYMBOL [--protocol data/market/FILE.json] [--protocol-sha256 HASH]");
  }
  const values = new Map();
  for (let i = 1; i < args.length; i += 2) {
    if (!new Set(["--pid", "--until", "--symbol", "--protocol", "--protocol-sha256"]).has(args[i]) || values.has(args[i])) {
      throw new Error("Invalid or repeated watchdog argument.");
    }
    values.set(args[i], args[i + 1]);
  }
  const pid = Number(values.get("--pid"));
  const until = values.get("--until");
  const symbol = values.get("--symbol");
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) {
    throw new Error("Watchdog requires a distinct, positive collector PID.");
  }
  if (!until || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(until) || Number.isNaN(Date.parse(until))) {
    throw new Error("Watchdog requires an exact ISO UTC --until timestamp.");
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol ?? "")) {
    throw new Error("Watchdog requires a valid --symbol.");
  }
  const protocolSha256 = values.get("--protocol-sha256") ?? null;
  if (protocolSha256 !== null && !/^[a-fA-F0-9]{64}$/.test(protocolSha256)) {
    throw new Error("Watchdog protocol SHA-256 must be a 64-character hex digest.");
  }
  const protocol = (values.get("--protocol") ?? defaultProtocol).replaceAll("\\", "/");
  if (!/^data\/market\/forward-protocol-[A-Za-z0-9-]+\.json$/.test(protocol)) {
    throw new Error("Watchdog protocol path must name a forward-protocol JSON file directly under data/market.");
  }
  return { pid, until: new Date(until).toISOString(), symbol, protocol, protocolSha256: protocolSha256?.toLowerCase() ?? null };
}

export function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function evaluateWatchdogSnapshot(snapshot, tracker, nowMs, limits = WATCHDOG_LIMITS) {
  const { config, status, lockPid, processAlive, expected, protocolSha256 } = snapshot;
  const fail = (reason) => ({ state: "FAILED", reason, tracker });
  if (expected.protocolSha256 && protocolSha256 !== expected.protocolSha256) {
    return fail("Frozen forward protocol SHA-256 changed or could not be verified.");
  }
  if (!config || config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT || config.symbol !== expected.symbol) {
    return fail("Public-data configuration, endpoint, or symbol changed.");
  }
  if (!processAlive && status?.state !== "COMPLETED") {
    return fail("Collector process exited before reporting completion.");
  }
  if (status && (status.pid !== expected.pid || status.endsAt !== expected.until || status.symbol !== expected.symbol || status.endpoint !== PUBLIC_ENDPOINT || status.mode !== "public-data-only")) {
    if (status.pid !== expected.pid && !tracker.collectorStartedAt && nowMs - tracker.startedAtMs < limits.startupGraceMs) {
      return { state: "WAITING_START", reason: "Waiting for this collector's status file.", tracker };
    }
    return fail("Collector status identity, window, or public endpoint does not match the watchdog run.");
  }
  if (!processAlive) {
    if (status?.state === "COMPLETED" && status.pid === expected.pid) {
      if (nowMs + 30_000 < Date.parse(expected.until)) {
        return fail("Collector reported completion before the requested end time.");
      }
      if (tracker.collectorStartedAt && status.startedAt !== tracker.collectorStartedAt) {
        return fail("Collector start identity changed while being monitored.");
      }
      return { state: "COMPLETED", reason: "Collector reported completion; forward-window audit is still required.", tracker };
    }
    return fail("Collector process exited without a matching completion status.");
  }
  if (!status) {
    if (nowMs - tracker.startedAtMs >= limits.startupGraceMs) {
      return fail("Collector did not publish a matching status within startup grace.");
    }
    return { state: "WAITING_START", reason: "Waiting for the collector status file.", tracker };
  }
  if (tracker.collectorStartedAt && status.startedAt !== tracker.collectorStartedAt) {
    return fail("Collector start identity changed while being monitored.");
  }
  const next = { ...tracker, collectorStartedAt: status.startedAt };
  if (!status.startedAt || Number.isNaN(Date.parse(status.startedAt))) {
    return fail("Collector status has no valid start timestamp.");
  }
  if (status.state === "COMPLETED") {
    if (nowMs + 30_000 < Date.parse(expected.until)) {
      return fail("Collector reported completion before the requested end time.");
    }
    return { state: "COMPLETED", reason: "Collector reported completion; forward-window audit is still required.", tracker: next };
  }
  if (["FAILED", "STOPPED", "PAUSED", "INCOMPLETE"].includes(status.state)) {
    return { state: "FAILED", reason: `Collector ended in ${status.state}: ${status.lastError ?? status.lastWarning ?? "no reason recorded"}`, tracker: next };
  }
  if (!["STARTING", "RUNNING", "RECONNECTING", "FINALIZING"].includes(status.state)) {
    return fail(`Collector has an unrecognized state: ${status.state}`);
  }
  if (lockPid !== expected.pid) {
    if (status.state === "STARTING" && lockPid === null && nowMs - tracker.startedAtMs < limits.startupGraceMs) {
      return { state: "WAITING_START", reason: "Waiting for the collector lock.", tracker: next };
    }
    return fail("Collector lock is missing or its PID does not match.");
  }
  const updatedAtMs = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs > nowMs + 60_000) {
    return fail("Collector status timestamp is invalid or in the future.");
  }
  if (status.state === "STARTING" && nowMs - tracker.startedAtMs < limits.startupGraceMs) {
    return { state: "WAITING_START", reason: "Collector startup catch-up is still in progress.", tracker: next };
  }
  if (nowMs - updatedAtMs > limits.staleStatusMs) {
    return fail("Collector status heartbeat is stale.");
  }
  if (status.state === "STARTING") {
    return fail("Collector remained in STARTING beyond startup grace.");
  }
  if (nowMs > Date.parse(expected.until) + limits.finishGraceMs) {
    return fail("Collector did not finish within the allowed finalization grace.");
  }
  if (status.state === "FINALIZING" || nowMs >= Date.parse(expected.until)) {
    return { state: "WATCHING", reason: "Waiting for collector finalization.", tracker: next };
  }
  if (!Number.isSafeInteger(status.ticksReceived) || status.ticksReceived < 0 ||
      (status.lastTickEpoch !== null && (!Number.isSafeInteger(status.lastTickEpoch) || status.lastTickEpoch < 1))) {
    return fail("Collector progress counters are invalid.");
  }
  if (next.lastTickEpoch !== null && status.lastTickEpoch !== null && status.lastTickEpoch < next.lastTickEpoch) {
    return fail("Collector tick epoch moved backwards.");
  }
  if (next.ticksReceived !== null && status.ticksReceived < next.ticksReceived) {
    return fail("Collector received-tick counter moved backwards.");
  }
  if (next.firstRunningAtMs === null) next.firstRunningAtMs = nowMs;
  const tickAdvanced = status.lastTickEpoch !== null && (next.lastTickEpoch === null || status.lastTickEpoch > next.lastTickEpoch);
  const countAdvanced = next.ticksReceived === null || status.ticksReceived > next.ticksReceived;
  if (tickAdvanced && countAdvanced) next.lastProgressAtMs = nowMs;
  next.lastTickEpoch = status.lastTickEpoch;
  next.ticksReceived = status.ticksReceived;
  const lastProgressAtMs = next.lastProgressAtMs ?? next.firstRunningAtMs;
  if (nowMs - lastProgressAtMs >= limits.noProgressMs) {
    return { state: "FAILED", reason: "No advancing public tick received within the progress limit.", tracker: next };
  }
  return { state: "WATCHING", reason: status.state, tracker: next };
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameStatusFileWithRetry(temporary, filePath);
}

async function run() {
  const expected = parseWatchdogArgs(process.argv.slice(2));
  const protocolPath = path.resolve(projectRoot, expected.protocol);
  const alertPath = path.join(marketDirectory, `live-watchdog-alert-${expected.pid}-${Date.parse(expected.until)}.json`);
  let tracker = {
    startedAtMs: Date.now(),
    collectorStartedAt: null,
    firstRunningAtMs: null,
    lastProgressAtMs: null,
    lastTickEpoch: null,
    ticksReceived: null,
  };
  for (;;) {
    let result;
    let collectorStatus = null;
    try {
      const [configText, statusText, lockText, protocolText] = await Promise.all([
        readFile(configPath, "utf8"),
        readOptionalText(collectorStatusPath),
        readOptionalText(lockPath),
        expected.protocolSha256 ? readFile(protocolPath) : Promise.resolve(null),
      ]);
      collectorStatus = statusText ? JSON.parse(statusText) : null;
      const lockPid = lockText === null || lockText.trim() === "" ? null : Number(lockText.trim());
      result = evaluateWatchdogSnapshot({
        config: JSON.parse(configText),
        status: collectorStatus,
        lockPid,
        processAlive: processIsRunning(expected.pid),
        expected,
        protocolSha256: protocolText === null ? null : createHash("sha256").update(protocolText).digest("hex"),
      }, tracker, Date.now());
      tracker = result.tracker;
    } catch (error) {
      result = { state: "FAILED", reason: `Watchdog could not verify collector state: ${error.message}` };
    }
    const status = {
      state: result.state,
      reason: result.reason,
      watchdogPid: process.pid,
      collectorPid: expected.pid,
      collectorState: collectorStatus?.state ?? null,
      symbol: expected.symbol,
      endpoint: PUBLIC_ENDPOINT,
      endsAt: expected.until,
      protocol: expected.protocol,
      protocolSha256: expected.protocolSha256,
      lastTickEpoch: collectorStatus?.lastTickEpoch ?? null,
      ticksReceived: collectorStatus?.ticksReceived ?? null,
      alertPath: result.state === "FAILED" ? alertPath : null,
      updatedAt: new Date().toISOString(),
    };
    if (result.state === "FAILED") {
      await writeJsonAtomic(alertPath, status);
    }
    await writeJsonAtomic(watchdogStatusPath, status);
    if (result.state === "FAILED") {
      console.error(result.reason);
      process.exitCode = 2;
      return;
    }
    if (result.state === "COMPLETED") {
      console.log("Collector completed; forward-window row-level audit is still required.");
      return;
    }
    await delay(WATCHDOG_LIMITS.pollMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
