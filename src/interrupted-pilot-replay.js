import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { symbolDataDirectory } from "./data-store.js";
import { auditForwardArchive } from "./forward-replay.js";
import { auditForwardWindow } from "./forward-window-audit-cli.js";
import { assertPilotWindowClosed, evaluatePilotTicks, validatePilotProtocol } from "./pilot-replay.js";

const PUBLIC_ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const LIVE_SOURCE = "Deriv public live tick subscription";
const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "STOPPED"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error(`Cannot verify collector PID ${pid} has exited: ${error.message}`);
  }
}

async function assertNoCollectorLock(marketDirectory) {
  try {
    await readFile(path.join(marketDirectory, "collector.lock"));
    throw new Error("Collector lock remains; the offline fallback must wait for shutdown.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function validateTerminatedPilotCollector(status, protocol, isCollectorAlive = pidIsAlive) {
  if (!TERMINAL_STATES.has(status?.state) ||
      status.mode !== "public-data-only" ||
      status.collectionMode !== "forward-only" ||
      status.finalization?.requested !== false ||
      status.symbol !== protocol.source.symbol || status.endpoint !== PUBLIC_ENDPOINT ||
      status.endsAt !== "2026-10-08T00:00:00.000Z" ||
      !Number.isSafeInteger(status.pid) || status.pid < 1 ||
      !Number.isFinite(Date.parse(status.startedAt)) ||
      Date.parse(status.startedAt) > Date.parse(protocol.eligibleWindow.fromUtcInclusive) ||
      !Number.isFinite(Date.parse(status.updatedAt))) {
    throw new Error("Pilot collector terminal state or public-only safety lock is invalid.");
  }
  if (isCollectorAlive(status.pid)) {
    throw new Error("Pilot collector process is still alive; the offline fallback must wait for shutdown.");
  }
  return {
    state: status.state,
    pid: status.pid,
    collectionMode: status.collectionMode,
    startedAt: status.startedAt,
    endsAt: status.endsAt,
    updatedAt: status.updatedAt,
    ticksReceived: status.ticksReceived,
    ticksStored: status.ticksStored,
    chunksStored: status.chunksStored,
    reconnects: status.reconnects,
    lastTickEpoch: status.lastTickEpoch,
    lastError: status.lastError,
  };
}

async function verifyLiveChunkProvenance(projectRoot, symbol, fromEpoch, toEpochExclusive,
  auditedManifestSha256) {
  const manifestBytes = await readFile(path.join(symbolDataDirectory(projectRoot, symbol),
    "manifest.json"));
  if (sha256(manifestBytes) !== auditedManifestSha256) {
    throw new Error("Archive manifest changed between row-level audit and replay.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const selected = manifest.chunks.filter((chunk) =>
    chunk.lastEpoch >= fromEpoch && chunk.firstEpoch < toEpochExclusive);
  for (const chunk of selected) {
    if (chunk.source !== LIVE_SOURCE) {
      throw new Error(`Eligible chunk ${chunk.file} is not labelled as a public live subscription.`);
    }
  }
  return { selectedLiveChunks: selected.length, source: LIVE_SOURCE };
}

export async function runInterruptedPilotReplay({ projectRoot, protocolPath,
  expectedProtocolSha256, nowMs = Date.now(), isCollectorAlive = pidIsAlive }) {
  if (!/^[a-f0-9]{64}$/.test(expectedProtocolSha256 ?? "")) {
    throw new Error("The frozen v3 pilot protocol SHA-256 is required.");
  }
  const protocolBytes = await readFile(protocolPath);
  const protocolSha256 = sha256(protocolBytes);
  if (protocolSha256 !== expectedProtocolSha256) {
    throw new Error("Frozen v3 pilot protocol checksum changed.");
  }
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  const { fromEpoch, toEpochExclusive } = validatePilotProtocol(protocol);
  // This check precedes all archive reads, so strategy performance cannot be
  // inspected while any eligible-window ticks are still arriving.
  assertPilotWindowClosed(toEpochExclusive, nowMs);

  const marketDirectory = path.join(projectRoot, "data", "market");
  await assertNoCollectorLock(marketDirectory);
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== protocol.source.symbol) {
    throw new Error("Public-only collector configuration safety lock changed.");
  }
  const collectorStatus = JSON.parse(await readFile(path.join(marketDirectory,
    "live-collector-status.json"), "utf8"));
  const collector = validateTerminatedPilotCollector(collectorStatus, protocol, isCollectorAlive);

  const rowAudit = await auditForwardWindow({ projectRoot,
    symbol: protocol.source.symbol, fromEpoch, toEpochExclusive });
  if (rowAudit.state === "FAILED" || rowAudit.duplicateRows !== 0 ||
      rowAudit.conflictingRows !== 0) {
    throw new Error("Row-level audit found duplicate, conflicting or invalid archived ticks.");
  }
  const { quotes, present, audit } = await auditForwardArchive({ projectRoot,
    symbol: protocol.source.symbol, fromEpoch, toEpochExclusive });
  if (rowAudit.expectedRows !== audit.expectedSeconds ||
      rowAudit.availableRows !== audit.observedGenuineSeconds ||
      rowAudit.missingRows !== audit.missingSeconds ||
      rowAudit.verifiedChunks !== audit.selectedChunks) {
    throw new Error("Independent row-level audits disagree; do not replay this archive.");
  }
  const provenance = await verifyLiveChunkProvenance(projectRoot, protocol.source.symbol,
    fromEpoch, toEpochExclusive, audit.manifestSha256);

  if (collector.state === "COMPLETED" && rowAudit.state === "COMPLETE") {
    throw new Error("Pilot completed with full coverage; use the standard pinned pilot replay.");
  }
  const evaluation = evaluatePilotTicks({ quotes, present, fromEpoch, toEpochExclusive });
  const report = {
    kind: "interrupted-public-short-pilot-replay",
    mode: "offline-development-research-only",
    decision: "INCOMPLETE_DEVELOPMENT_ONLY",
    generatedAtUtc: new Date(nowMs).toISOString(),
    protocolPath,
    protocolSha256,
    window: {
      fromUtcInclusive: protocol.eligibleWindow.fromUtcInclusive,
      toUtcExclusive: protocol.eligibleWindow.toUtcExclusive,
      symbol: protocol.source.symbol,
    },
    collector,
    archive: provenance,
    audit,
    rowLevelAudit: rowAudit,
    ...evaluation,
    botBuilderRunPermission: false,
    demoOrderPermission: false,
    realOrderPermission: false,
    accountOrTokenUsePermission: false,
    limitations: [
      "The v3 pilot has missing seconds or ended without clean completion; this is not a clean prospective forward validation.",
      "Every missing second stays absent. Indicators reset after each gap and at the chronological midpoint; no decision, entry or settlement spans one.",
      "All 18 fixed scenarios are descriptive development evidence, including zero-observation scenarios; none is an optimization or trading gate.",
      "Public ticks are not executable contract quotes; processing delays and payouts are sensitivity assumptions, not fills.",
      "Deriv Bot Builder Bollinger/RSI and tick-timing parity remains unverified.",
      "No Bot Builder Run, Demo or real orders, account access, or money movement is permitted by this report.",
    ],
  };
  const reportPath = path.join(projectRoot, "data", "reports",
    `interrupted-pilot-replay-${protocol.source.symbol}-${fromEpoch}-${toEpochExclusive}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
