import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchGapContext } from "./historical-gap-repair-cli.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";
import { auditForwardWindow } from "./forward-window-audit-cli.js";
import { auditForwardArchive } from "./forward-replay.js";
import { validateTerminatedPilotCollector } from "./interrupted-pilot-replay.js";
import { validatePilotProtocol } from "./pilot-replay.js";

const PROTOCOL_SHA = "3847b023023dbe5434fb23b71cad4a6d376f42fe26393e605348a1267722979e";
const CONTEXT_SECONDS = 20;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export function verifyHistoricalGapResponse(archivedContext, fetchedTicks, missingRange) {
  const { firstEpoch, lastEpoch } = missingRange;
  const archived = new Map(archivedContext.map(({ epoch, quote }) => [epoch, quote]));
  const fetched = new Map();
  for (const tick of fetchedTicks) {
    if (!Number.isSafeInteger(tick.epoch) || !Number.isFinite(tick.quote)) {
      throw new Error("Historical response contains an invalid tick.");
    }
    if (fetched.has(tick.epoch) && fetched.get(tick.epoch) !== tick.quote) {
      throw new Error(`Historical response conflicts with itself at ${tick.epoch}.`);
    }
    fetched.set(tick.epoch, tick.quote);
    if (archived.has(tick.epoch) && archived.get(tick.epoch) !== tick.quote) {
      throw new Error(`Historical quote conflicts with live quote at ${tick.epoch}.`);
    }
  }
  for (const anchor of [firstEpoch - 1, lastEpoch + 1]) {
    if (!archived.has(anchor) || fetched.get(anchor) !== archived.get(anchor)) {
      throw new Error(`Historical response did not confirm live boundary tick ${anchor}.`);
    }
  }
  const recovered = [];
  const stillMissing = [];
  for (let epoch = firstEpoch; epoch <= lastEpoch; epoch += 1) {
    if (archived.has(epoch)) throw new Error(`Live audit no longer marks ${epoch} missing.`);
    if (fetched.has(epoch)) recovered.push({ epoch, quote: fetched.get(epoch) });
    else stillMissing.push(epoch);
  }
  return { recovered, stillMissing };
}

export async function captureRetrospectivePilotGaps({ projectRoot, client = new DerivPublicClient(),
  nowMs = Date.now(), isCollectorAlive = pidIsAlive, fetchOptions } = {}) {
  if (!projectRoot || client.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Safety lock: recovery requires the public Deriv endpoint.");
  }
  const market = path.join(projectRoot, "data", "market");
  const protocolBytes = await readFile(path.join(market, "forward-protocol-2026-10-07-v3-pilot.json"));
  if (sha256(protocolBytes) !== PROTOCOL_SHA) throw new Error("Frozen pilot protocol checksum changed.");
  const protocol = JSON.parse(protocolBytes);
  const { fromEpoch, toEpochExclusive } = validatePilotProtocol(protocol);
  if (nowMs < toEpochExclusive * 1000) throw new Error("Pilot window has not closed.");
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== protocol.source.symbol) {
    throw new Error("Public-only configuration safety lock changed.");
  }
  try {
    await readFile(path.join(market, "collector.lock"));
    throw new Error("Collector lock is still present.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const status = JSON.parse(await readFile(path.join(market, "live-collector-status.json"), "utf8"));
  const collector = validateTerminatedPilotCollector(status, protocol, isCollectorAlive);
  if (collector.state !== "COMPLETED") throw new Error("Pilot collector did not complete.");
  const audit = await auditForwardWindow({ projectRoot, symbol: protocol.source.symbol,
    fromEpoch, toEpochExclusive });
  if (audit.state !== "INCONCLUSIVE" || audit.missingRows !== 220 ||
      audit.duplicateRows !== 0 || audit.conflictingRows !== 0 ||
      audit.expectedRows !== 25_200) {
    throw new Error("Original live audit differs from the recorded 220-second gap.");
  }
  const { quotes, present, audit: archiveAudit } = await auditForwardArchive({ projectRoot,
    symbol: protocol.source.symbol, fromEpoch, toEpochExclusive });
  if (archiveAudit.missingSeconds !== audit.missingRows ||
      archiveAudit.observedGenuineSeconds !== audit.availableRows) {
    throw new Error("Independent live archive audits disagree.");
  }
  const manifestBytes = await readFile(path.join(market, protocol.source.symbol, "manifest.json"));
  if (sha256(manifestBytes) !== archiveAudit.manifestSha256) {
    throw new Error("Live manifest changed between audits.");
  }
  const manifest = JSON.parse(manifestBytes);
  if (manifest.chunks.some((chunk) => chunk.firstEpoch < toEpochExclusive &&
      chunk.lastEpoch >= fromEpoch && chunk.source !== "Deriv public live tick subscription")) {
    throw new Error("Pilot archive includes a non-live chunk.");
  }
  const ranges = [];
  const allRecovered = [];
  try {
    for (const gap of audit.missingRanges) {
      const contextStart = Math.max(fromEpoch, gap.firstEpoch - CONTEXT_SECONDS);
      const contextEnd = Math.min(toEpochExclusive - 1, gap.lastEpoch + CONTEXT_SECONDS);
      const archivedContext = [];
      for (let epoch = contextStart; epoch <= contextEnd; epoch += 1) {
        const offset = epoch - fromEpoch;
        if (present[offset]) archivedContext.push({ epoch, quote: quotes[offset] });
      }
      const fetched = await fetchGapContext(client, protocol.source.symbol,
        contextStart, contextEnd, fetchOptions);
      const { recovered, stillMissing } = verifyHistoricalGapResponse(
        archivedContext, fetched, gap);
      ranges.push({ ...gap, contextStart, contextEnd, fetchedRows: fetched.length,
        fetchedSha256: sha256(Buffer.from(JSON.stringify(fetched))),
        recoveredRows: recovered.length, stillMissingRows: stillMissing.length,
        recovered, stillMissing });
      allRecovered.push(...recovered);
    }
  } finally {
    client.close();
  }
  const afterManifestSha256 = sha256(await readFile(path.join(market,
    protocol.source.symbol, "manifest.json")));
  if (afterManifestSha256 !== archiveAudit.manifestSha256) {
    throw new Error("Live manifest changed during historical recovery.");
  }
  const stillMissingRows = ranges.reduce((sum, range) => sum + range.stillMissingRows, 0);
  const report = {
    kind: "retrospective-public-history-gap-recovery",
    state: stillMissingRows === 0 ? "RECOVERED_SEPARATELY" : "PARTIAL_SOURCE_GAP",
    generatedAtUtc: new Date(nowMs).toISOString(),
    symbol: protocol.source.symbol, endpoint: PUBLIC_ENDPOINT,
    fromEpoch, toEpochExclusive, protocolSha256: PROTOCOL_SHA,
    liveManifestSha256: archiveAudit.manifestSha256,
    originalLiveAudit: audit,
    provenance: "Deriv public ticks_history requested after the live pilot cutoff",
    recoveredRows: allRecovered.length, stillMissingRows,
    ranges,
    recoveredTicksSha256: sha256(Buffer.from(JSON.stringify(allRecovered))),
    livePilotStatusUnchanged: "INCONCLUSIVE",
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
  };
  const reportPath = path.join(projectRoot, "data", "reports",
    `retrospective-pilot-recovery-${protocol.source.symbol}-${fromEpoch}-${toEpochExclusive}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
