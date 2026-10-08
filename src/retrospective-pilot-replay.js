import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditForwardArchive } from "./forward-replay.js";
import { evaluatePilotTicks } from "./pilot-replay.js";

const FROM = 1791392400;
const TO = 1791417600;
const SYMBOL = "1HZ100V";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function overlayVerifiedHistory(quotes, present, recovered, fromEpoch) {
  if (quotes.length !== present.length) throw new Error("Quote and presence arrays differ.");
  const compositeQuotes = Float64Array.from(quotes);
  const compositePresent = Uint8Array.from(present);
  let added = 0;
  for (const { epoch, quote } of recovered) {
    const offset = epoch - fromEpoch;
    if (!Number.isSafeInteger(epoch) || !Number.isFinite(quote) ||
        offset < 0 || offset >= quotes.length || compositePresent[offset]) {
      throw new Error("Recovered row is invalid or would replace a live tick.");
    }
    compositeQuotes[offset] = quote;
    compositePresent[offset] = 1;
    added += 1;
  }
  return { quotes: compositeQuotes, present: compositePresent, added };
}

export async function runRetrospectivePilotReplay({ projectRoot }) {
  const recoveryPath = path.join(projectRoot, "data", "reports",
    `retrospective-pilot-recovery-${SYMBOL}-${FROM}-${TO}.json`);
  const recoveryBytes = await readFile(recoveryPath);
  const recovery = JSON.parse(recoveryBytes);
  if (recovery.kind !== "retrospective-public-history-gap-recovery" ||
      recovery.state !== "RECOVERED_SEPARATELY" || recovery.recoveredRows !== 220 ||
      recovery.stillMissingRows !== 0 || recovery.symbol !== SYMBOL ||
      recovery.fromEpoch !== FROM || recovery.toEpochExclusive !== TO ||
      recovery.livePilotStatusUnchanged !== "INCONCLUSIVE") {
    throw new Error("Retrospective recovery report is incomplete or differs from the pilot.");
  }
  const recovered = recovery.ranges.flatMap((range) => range.recovered);
  if (recovered.length !== 220 ||
      sha256(Buffer.from(JSON.stringify(recovered))) !== recovery.recoveredTicksSha256) {
    throw new Error("Recovered tick count or checksum failed.");
  }
  const { quotes, present, audit } = await auditForwardArchive({ projectRoot,
    symbol: SYMBOL, fromEpoch: FROM, toEpochExclusive: TO });
  if (audit.manifestSha256 !== recovery.liveManifestSha256 ||
      audit.missingSeconds !== 220 || audit.observedGenuineSeconds !== 24_980) {
    throw new Error("Original live archive changed after historical recovery.");
  }
  const composite = overlayVerifiedHistory(quotes, present, recovered, FROM);
  if (composite.added !== 220 || composite.present.some((value) => value !== 1)) {
    throw new Error("Combined development series is not complete.");
  }
  const evaluation = evaluatePilotTicks({ ...composite,
    fromEpoch: FROM, toEpochExclusive: TO });
  if (evaluation.scenarioLedger.length !== 18) throw new Error("Fixed scenario count changed.");
  const report = {
    kind: "retrospective-composite-pilot-replay",
    decision: "RETROSPECTIVE_DEVELOPMENT_ONLY",
    generatedAtUtc: new Date().toISOString(),
    symbol: SYMBOL, fromEpoch: FROM, toEpochExclusive: TO,
    originalLiveRows: 24_980, historicalRowsAdded: 220, combinedRows: 25_200,
    originalLiveStatus: "INCONCLUSIVE",
    recoveryPath, recoverySha256: sha256(recoveryBytes),
    originalLiveManifestSha256: audit.manifestSha256,
    sourceRule: "Historical rows are used only in this separately labelled development series.",
    ...evaluation,
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
    limitations: [
      "The 220 retrospective ticks do not repair the original prospective pilot.",
      "The original pilot and prior 30-day archive have already been inspected; neither is an untouched test.",
      "Public ticks are not executable quotes; payout and delay are assumptions.",
      "Bot Builder indicator and tick-timing parity remains unverified.",
    ],
  };
  const reportPath = path.join(projectRoot, "data", "reports",
    `retrospective-pilot-replay-${SYMBOL}-${FROM}-${TO}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
