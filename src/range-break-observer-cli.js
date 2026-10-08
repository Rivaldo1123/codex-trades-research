import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { renameStatusFileWithRetry } from "./atomic-status.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";
import { reconnectDelay, subscribePublicTicks } from "./live-data-collector.js";
import {
  createRangeBreakObservationState,
  observationHash,
  observationStateSummary,
  observeRangeBreakTick,
  rangeBreakObservationProposalRequest,
  sanitizePublicObservation,
  validateRangeBreakObservationProtocol,
} from "./range-break-observer.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(
  projectRoot,
  "research",
  "protocols",
  "range-break-observation-v1.json",
);
const observationDirectory = path.join(projectRoot, "data", "range-break-observer");
const statusPath = path.join(observationDirectory, "status.json");
const lockPath = path.join(observationDirectory, "observer.lock");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function writeStatus(status) {
  await mkdir(observationDirectory, { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await renameStatusFileWithRetry(temporary, statusPath);
}

async function acquireLock() {
  await mkdir(observationDirectory, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("A Range Break observer already holds the local lock.");
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

function boundedDuration(protocol) {
  const override = argumentValue("--duration-seconds");
  if (override === null) return protocol.durationSeconds;
  const parsed = Number(override);
  if (!Number.isSafeInteger(parsed) || parsed < 30 || parsed > protocol.durationSeconds) {
    throw new Error(`--duration-seconds must be from 30 through ${protocol.durationSeconds}.`);
  }
  return parsed;
}

async function run() {
  const protocolBytes = await readFile(protocolPath);
  const protocol = validateRangeBreakObservationProtocol(
    JSON.parse(protocolBytes.toString("utf8")),
  );
  const durationSeconds = boundedDuration(protocol);
  const releaseLock = await acquireLock();
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + durationSeconds * 1000);
  const sessionId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const rawPath = path.join(observationDirectory, `${sessionId}.jsonl`);
  const manifestPath = path.join(observationDirectory, `${sessionId}.manifest.json`);
  const rawHandle = await open(rawPath, "wx");
  const controller = new AbortController();
  const observationState = createRangeBreakObservationState(protocol);
  let writeChain = Promise.resolve();
  let statusChain = Promise.resolve();
  let fatalError = null;
  let proposalClient = null;
  const status = {
    authenticated: false,
    endpoint: PUBLIC_ENDPOINT,
    endsAt: endsAt.toISOString(),
    executionAuthorized: false,
    lastError: null,
    manifestPath,
    ordersPlaced: 0,
    pid: process.pid,
    protocolId: protocol.protocolId,
    rawPath,
    sessionId,
    startedAt: startedAt.toISOString(),
    state: "STARTING",
    summary: observationStateSummary(observationState),
    updatedAt: startedAt.toISOString(),
  };
  const persistStatus = async () => {
    status.summary = observationStateSummary(observationState);
    status.updatedAt = new Date().toISOString();
    await writeStatus(status);
  };
  const writeObservation = (record) => {
    writeChain = writeChain.then(() => rawHandle.appendFile(
      `${JSON.stringify(record)}\n`,
      "utf8",
    )).catch((error) => {
      fatalError = error;
      controller.abort();
    });
    return writeChain;
  };
  const stopTimer = setTimeout(() => controller.abort(), durationSeconds * 1000);
  const statusTimer = setInterval(() => {
    statusChain = statusChain.then(persistStatus).catch((error) => {
      fatalError = error;
      controller.abort();
    });
  }, 15_000);
  const stopForSignal = () => controller.abort();
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  try {
    await writeObservation({
      observedAtUtc: startedAt.toISOString(),
      protocolId: protocol.protocolId,
      type: "session_start",
    });
    status.state = "RUNNING";
    await persistStatus();

    const tickTask = (async () => {
      let reconnectAttempt = 0;
      while (!controller.signal.aborted && observationState.ticks < protocol.maximumTicks) {
        try {
          await subscribePublicTicks({
            endpoint: protocol.endpoint,
            signal: controller.signal,
            symbol: protocol.symbol,
            async onTick(tick) {
              if (observationState.ticks >= protocol.maximumTicks) {
                controller.abort();
                return;
              }
              const normalized = observeRangeBreakTick(observationState, tick);
              await writeObservation({
                observedAtUtc: new Date().toISOString(),
                symbol: protocol.symbol,
                tick: normalized,
                type: "tick",
              });
            },
          });
          reconnectAttempt = 0;
        } catch (error) {
          if (controller.signal.aborted) break;
          observationState.sourceDiscontinuities += 1;
          observationState.reconnects += 1;
          await writeObservation({
            error: error.message,
            observedAtUtc: new Date().toISOString(),
            reconnect: observationState.reconnects,
            type: "source_discontinuity",
          });
          if (observationState.reconnects > protocol.maximumReconnects) {
            throw new Error("Range Break tick branch exhausted its bounded reconnect budget.");
          }
          reconnectAttempt += 1;
          await reconnectDelay(reconnectAttempt, controller.signal).catch(() => {});
        }
      }
    })();

    const proposalTask = (async () => {
      proposalClient = new DerivPublicClient(protocol.endpoint);
      await proposalClient.connect();
      const capability = await proposalClient.request(
        { contracts_for: protocol.symbol },
        "contracts_for",
        30_000,
      );
      await writeObservation({
        observedAtUtc: new Date().toISOString(),
        response: sanitizePublicObservation(capability),
        type: "capability",
      });
      while (!controller.signal.aborted &&
          observationState.proposalSnapshots < protocol.maximumProposalSnapshots) {
        for (const contractType of protocol.proposalTerms.contractTypes) {
          if (controller.signal.aborted ||
              observationState.proposalSnapshots >= protocol.maximumProposalSnapshots) break;
          const request = rangeBreakObservationProposalRequest(protocol, contractType);
          try {
            const response = await proposalClient.request(request, "proposal", 30_000);
            observationState.proposalSnapshots += 1;
            await writeObservation({
              contractType,
              observedAtUtc: new Date().toISOString(),
              request,
              response: sanitizePublicObservation(response),
              type: "indicative_proposal",
            });
          } catch (error) {
            observationState.proposalFailures += 1;
            observationState.proposalSnapshots += 1;
            await writeObservation({
              contractType,
              error: error.message,
              observedAtUtc: new Date().toISOString(),
              request,
              type: "indicative_proposal_failure",
            });
            if (/rate\s*limit/i.test(error.message)) return;
          }
        }
        if (observationState.proposalSnapshots >= protocol.maximumProposalSnapshots) break;
        await delay(protocol.proposalIntervalSeconds * 1000, undefined, {
          signal: controller.signal,
        }).catch(() => {});
      }
    })();

    await Promise.all([tickTask, proposalTask]);
    await writeChain;
    if (fatalError) throw fatalError;
    status.state = controller.signal.aborted ? "COMPLETED_BOUNDED_STOP" : "COMPLETED";
  } catch (error) {
    fatalError = error;
    status.state = "FAILED";
    status.lastError = error.message;
  } finally {
    controller.abort();
    proposalClient?.close();
    clearTimeout(stopTimer);
    clearInterval(statusTimer);
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);
    await writeObservation({
      classification: "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION",
      observedAtUtc: new Date().toISOString(),
      summary: observationStateSummary(observationState),
      type: "session_end",
    });
    await writeChain;
    await rawHandle.close();
    await statusChain;
    const rawBytes = await readFile(rawPath);
    const manifest = {
      authenticated: false,
      classification: "OBSERVATION_ONLY_NO_PROFIT_CONCLUSION",
      endpoint: protocol.endpoint,
      kind: "range-break-observation-manifest",
      ordersPlaced: 0,
      protocolId: protocol.protocolId,
      protocolSha256: observationHash(protocolBytes),
      rawFile: path.basename(rawPath),
      rawSha256: observationHash(rawBytes),
      schemaVersion: 1,
      sessionId,
      summary: observationStateSummary(observationState),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await persistStatus().catch(() => {});
    await releaseLock();
  }
  console.log(JSON.stringify({
    manifestPath,
    state: status.state,
    summary: status.summary,
  }, null, 2));
  if (fatalError) throw fatalError;
}

async function status() {
  console.log(await readFile(statusPath, "utf8"));
}

const command = process.argv[2] ?? "status";
const operation = command === "run" ? run() : command === "status" ? status() : null;
if (!operation) {
  console.error(`Unknown Range Break observer command: ${command}`);
  process.exitCode = 1;
} else {
  operation.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
