import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { BROWSER_FLOW_PARAMETERS } from "./browser-flow-backtest.js";
import { symbolDataDirectory } from "./data-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = Object.freeze([
  { id: "one-tick-rise-signal", direction: "rise" },
  { id: "one-tick-fall-signal", direction: "fall" },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireWindow(fromEpoch, toEpoch) {
  if (
    !Number.isSafeInteger(fromEpoch) ||
    !Number.isSafeInteger(toEpoch) ||
    fromEpoch < 1 ||
    toEpoch <= fromEpoch
  ) {
    throw new Error("--from and --to must be increasing Unix-second integers.");
  }
}

function summarizeMissing(ticks, fromEpoch, toEpoch) {
  const gaps = [];
  let missingTicks = 0;
  let expected = fromEpoch;
  for (const tick of ticks) {
    if (tick.epoch > expected) {
      const count = tick.epoch - expected;
      missingTicks += count;
      if (gaps.length < 10) {
        gaps.push({ fromEpoch: expected, toEpochExclusive: tick.epoch, missingTicks: count });
      }
    }
    expected = tick.epoch + 1;
  }
  if (expected < toEpoch) {
    const count = toEpoch - expected;
    missingTicks += count;
    if (gaps.length < 10) {
      gaps.push({ fromEpoch: expected, toEpochExclusive: toEpoch, missingTicks: count });
    }
  }
  return { gaps, missingTicks };
}

export class IncompleteHistoricalWindowError extends Error {
  constructor(details) {
    super(
      `INCOMPLETE: ${details.missingTicks} of ${details.expectedTicks} one-second ticks are missing from the requested window.`,
    );
    this.name = "IncompleteHistoricalWindowError";
    this.code = "INCOMPLETE";
    this.details = details;
  }
}

export async function loadExactArchivedWindow({
  projectRoot: root,
  symbol,
  fromEpoch,
  toEpoch,
}) {
  requireWindow(fromEpoch, toEpoch);
  const symbolDirectory = symbolDataDirectory(root, symbol);
  const manifestPath = path.join(symbolDirectory, "manifest.json");
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new IncompleteHistoricalWindowError({
      symbol,
      fromEpoch,
      toEpochExclusive: toEpoch,
      expectedTicks: toEpoch - fromEpoch,
      observedTicks: 0,
      missingTicks: toEpoch - fromEpoch,
      gaps: [{ fromEpoch, toEpochExclusive: toEpoch, missingTicks: toEpoch - fromEpoch }],
    });
  }

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== 1 || manifest.symbol !== symbol || !Array.isArray(manifest.chunks)) {
    throw new Error("Tick archive manifest has an unsupported format.");
  }
  const selectedChunks = manifest.chunks.filter(
    (chunk) => chunk.lastEpoch >= fromEpoch && chunk.firstEpoch < toEpoch,
  );
  const byEpoch = new Map();
  for (const chunk of selectedChunks) {
    const compressed = await readFile(path.join(symbolDirectory, chunk.file));
    if (sha256(compressed) !== chunk.sha256) {
      throw new Error(`Tick archive checksum failed for ${chunk.file}.`);
    }
    const lines = gunzipSync(compressed).toString("utf8").trimEnd().split("\n");
    if (lines.length !== chunk.rows) {
      throw new Error(`Tick archive row count failed for ${chunk.file}.`);
    }
    let first = Infinity;
    let last = -Infinity;
    for (const line of lines) {
      const tick = JSON.parse(line);
      if (!Number.isSafeInteger(tick.epoch) || !Number.isFinite(tick.quote)) {
        throw new Error(`Invalid archived tick in ${chunk.file}.`);
      }
      first = Math.min(first, tick.epoch);
      last = Math.max(last, tick.epoch);
      if (tick.epoch < fromEpoch || tick.epoch >= toEpoch) continue;
      const previous = byEpoch.get(tick.epoch);
      if (previous !== undefined && previous !== tick.quote) {
        throw new Error(`Archived quote conflict at epoch ${tick.epoch}.`);
      }
      byEpoch.set(tick.epoch, tick.quote);
    }
    if (first !== chunk.firstEpoch || last !== chunk.lastEpoch) {
      throw new Error(`Tick archive epoch bounds failed for ${chunk.file}.`);
    }
  }
  const currentManifestBytes = await readFile(manifestPath);
  if (sha256(currentManifestBytes) !== sha256(manifestBytes)) {
    throw new Error("Tick archive changed during the offline study; retry after collection stops.");
  }

  const ticks = [...byEpoch.entries()]
    .map(([epoch, quote]) => ({ epoch, quote }))
    .sort((left, right) => left.epoch - right.epoch);
  const expectedTicks = toEpoch - fromEpoch;
  if (ticks.length !== expectedTicks) {
    const { gaps, missingTicks } = summarizeMissing(ticks, fromEpoch, toEpoch);
    throw new IncompleteHistoricalWindowError({
      symbol,
      fromEpoch,
      toEpochExclusive: toEpoch,
      expectedTicks,
      observedTicks: ticks.length,
      missingTicks,
      gaps,
    });
  }
  return {
    ticks,
    archive: {
      manifestSha256: sha256(manifestBytes),
      manifestUpdatedAt: manifest.updatedAt ?? null,
      selectedChunks: selectedChunks.length,
    },
  };
}

function pricePrefix(ticks) {
  const prefix = new Float64Array(ticks.length + 1);
  for (let index = 0; index < ticks.length; index += 1) {
    prefix[index + 1] = prefix[index] + ticks[index].quote;
  }
  return prefix;
}

export function evaluateCandidateSegment(
  ticks,
  prefix,
  candidate,
  start,
  endExclusive,
  parameters = BROWSER_FLOW_PARAMETERS,
) {
  const first = Math.max(start, parameters.slowWindow - 1);
  const last = endExclusive - parameters.entryDelayTicks - parameters.horizonTicks;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  for (let index = first; index < last; index += 1) {
    const fast =
      (prefix[index + 1] - prefix[index + 1 - parameters.fastWindow]) /
      parameters.fastWindow;
    const slow =
      (prefix[index + 1] - prefix[index + 1 - parameters.slowWindow]) /
      parameters.slowWindow;
    const qualifies = candidate.direction === "rise" ? fast > slow : fast < slow;
    if (!qualifies) {
      skipped += 1;
      continue;
    }
    const entry = ticks[index + parameters.entryDelayTicks].quote;
    const exit = ticks[index + parameters.entryDelayTicks + parameters.horizonTicks].quote;
    const won = candidate.direction === "rise" ? exit > entry : exit < entry;
    if (won) wins += 1;
    else losses += 1; // An unchanged exit loses under the observed contract rules.
  }
  const observations = wins + losses;
  const netProfitPerDollarStake =
    wins * parameters.payoutOnWin + losses * parameters.payoutOnLoss;
  return {
    observations,
    skipped,
    wins,
    losses,
    winRate: observations ? wins / observations : null,
    netProfitPerDollarStake,
    averageProfitPerDollarStake: observations
      ? netProfitPerDollarStake / observations
      : null,
    profitFactor: losses
      ? (wins * parameters.payoutOnWin) / (-losses * parameters.payoutOnLoss)
      : null,
  };
}

export function createHistoricalStudyReport({ ticks, symbol, fromEpoch, toEpoch, archive }) {
  requireWindow(fromEpoch, toEpoch);
  if (ticks.length !== toEpoch - fromEpoch) {
    throw new Error("Historical study requires a complete exact one-Hz window.");
  }
  if (ticks.length < BROWSER_FLOW_PARAMETERS.slowWindow + 100) {
    throw new Error("Historical study window is too short for the fixed browser candidates.");
  }
  const trainBoundary = Math.floor(ticks.length * 0.7);
  const validationBoundary = Math.floor(ticks.length * 0.85);
  const prefix = pricePrefix(ticks);
  const candidates = CANDIDATES.map((candidate) => ({
    ...candidate,
    training: evaluateCandidateSegment(ticks, prefix, candidate, 0, trainBoundary),
    validation: evaluateCandidateSegment(
      ticks,
      prefix,
      candidate,
      trainBoundary,
      validationBoundary,
    ),
  }));
  const selected = [...candidates].sort((left, right) => {
    const leftScore = left.validation.averageProfitPerDollarStake ?? -Infinity;
    const rightScore = right.validation.averageProfitPerDollarStake ?? -Infinity;
    return rightScore - leftScore || left.id.localeCompare(right.id);
  })[0];
  const test = evaluateCandidateSegment(
    ticks,
    prefix,
    selected,
    validationBoundary,
    ticks.length,
  );
  return {
    kind: "offline-historical-study",
    generatedAt: new Date().toISOString(),
    symbol,
    window: {
      fromEpoch,
      toEpochExclusive: toEpoch,
      fromUtc: new Date(fromEpoch * 1000).toISOString(),
      toUtcExclusive: new Date(toEpoch * 1000).toISOString(),
      expectedTicks: toEpoch - fromEpoch,
      observedTicks: ticks.length,
      timeZone: "America/New_York",
    },
    archive,
    split: {
      method: "Chronological 70/15/15 by tick count",
      train: {
        fromEpoch,
        toEpochExclusive: fromEpoch + trainBoundary,
        ticks: trainBoundary,
      },
      validation: {
        fromEpoch: fromEpoch + trainBoundary,
        toEpochExclusive: fromEpoch + validationBoundary,
        ticks: validationBoundary - trainBoundary,
      },
      test: {
        fromEpoch: fromEpoch + validationBoundary,
        toEpochExclusive: toEpoch,
        ticks: ticks.length - validationBoundary,
      },
      boundaryRule: "Each signal, next-tick entry, and settlement must remain in its own segment.",
    },
    model: {
      ...BROWSER_FLOW_PARAMETERS,
      payoutBreakEvenWinRate:
        -BROWSER_FLOW_PARAMETERS.payoutOnLoss /
        (BROWSER_FLOW_PARAMETERS.payoutOnWin - BROWSER_FLOW_PARAMETERS.payoutOnLoss),
      tieRule: "loss",
      opportunityRule: "Every qualifying historical tick is scored as an independent opportunity.",
    },
    candidates,
    selection: {
      criterion: "Highest validation average profit per $1 stake; candidate IDs break ties.",
      selectedId: selected.id,
      validationPositive: selected.validation.averageProfitPerDollarStake > 0,
    },
    untouchedTest: { candidateId: selected.id, ...test },
    limitations: [
      "The one-tick entry delay and +$0.90/-$1.00 payout are fixed assumptions; actual quotes and processing delays can differ.",
      "Qualifying ticks are opportunities, not executable one-shot Bot Builder trades or independent observations.",
      "This offline report does not authorize running a bot or placing an order.",
    ],
  };
}

export async function runHistoricalStudy({ projectRoot: root, symbol, fromEpoch, toEpoch }) {
  const { ticks, archive } = await loadExactArchivedWindow({
    projectRoot: root,
    symbol,
    fromEpoch,
    toEpoch,
  });
  const report = createHistoricalStudyReport({ ticks, symbol, fromEpoch, toEpoch, archive });
  const reportsDirectory = path.join(root, "data", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const fileName = `historical-study-${symbol}-${fromEpoch}-${toEpoch}-${Date.now()}.json`;
  const reportPath = path.join(reportsDirectory, fileName);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}

export function parseCliArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!/^(--from|--to|--symbol)$/.test(option ?? "") || !value || values[option]) {
      throw new Error("Usage: node src/historical-study.js --from EPOCH --to EPOCH --symbol SYMBOL");
    }
    values[option] = value;
  }
  if (!/^\d+$/.test(values["--from"] ?? "") || !/^\d+$/.test(values["--to"] ?? "")) {
    throw new Error("Usage: node src/historical-study.js --from EPOCH --to EPOCH --symbol SYMBOL");
  }
  if (!values["--symbol"]) {
    throw new Error("Usage: node src/historical-study.js --from EPOCH --to EPOCH --symbol SYMBOL");
  }
  const fromEpoch = Number(values["--from"]);
  const toEpoch = Number(values["--to"]);
  requireWindow(fromEpoch, toEpoch);
  return { fromEpoch, toEpoch, symbol: values["--symbol"] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const { reportPath, report } = await runHistoricalStudy({ projectRoot, ...options });
    console.log(JSON.stringify({ reportPath, selection: report.selection }, null, 2));
  } catch (error) {
    if (error.code === "INCOMPLETE") {
      console.error(JSON.stringify({ code: error.code, ...error.details }, null, 2));
      process.exitCode = 2;
    } else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
