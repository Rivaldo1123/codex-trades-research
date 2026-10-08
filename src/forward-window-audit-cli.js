import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { symbolDataDirectory } from "./data-store.js";
import { renameStatusFileWithRetry } from "./atomic-status.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINIMUM_COVERAGE = 0.999;

function utcEpoch(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value ?? "")) {
    throw new Error(`${name} must be an exact whole-second UTC ISO timestamp.`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().replace(/\.000Z$/, "Z") !== value.replace(/\.000Z$/, "Z")) {
    throw new Error(`${name} is not a valid UTC timestamp.`);
  }
  return millis / 1000;
}

export function parseForwardAuditArgs(args) {
  if (args.length !== 7 || args[0] !== "run") {
    throw new Error("Usage: node src/forward-window-audit-cli.js run --from UTC_ISO --to UTC_ISO --symbol SYMBOL");
  }
  const values = new Map();
  for (let i = 1; i < args.length; i += 2) {
    if (!["--from", "--to", "--symbol"].includes(args[i]) || values.has(args[i])) {
      throw new Error("Invalid or repeated forward-audit argument.");
    }
    values.set(args[i], args[i + 1]);
  }
  const fromEpoch = utcEpoch(values.get("--from"), "--from");
  const toEpochExclusive = utcEpoch(values.get("--to"), "--to");
  const symbol = values.get("--symbol");
  if (toEpochExclusive <= fromEpoch || toEpochExclusive - fromEpoch > 14 * 86_400) {
    throw new Error("Forward-audit window must be positive and no longer than 14 days.");
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol ?? "")) {
    throw new Error("Forward-audit symbol is invalid.");
  }
  return { fromEpoch, toEpochExclusive, symbol };
}

function rangesFromMarks(marks, fromEpoch, predicate) {
  const ranges = [];
  let first = null;
  for (let offset = 0; offset <= marks.length; offset += 1) {
    const active = offset < marks.length && predicate(marks[offset]);
    if (active && first === null) first = offset;
    if (!active && first !== null) {
      ranges.push({ firstEpoch: fromEpoch + first, lastEpoch: fromEpoch + offset - 1 });
      first = null;
    }
  }
  return ranges;
}

export async function auditForwardWindow({ projectRoot: root, symbol, fromEpoch, toEpochExclusive }) {
  if (!Number.isSafeInteger(fromEpoch) || !Number.isSafeInteger(toEpochExclusive) || toEpochExclusive <= fromEpoch || toEpochExclusive - fromEpoch > 14 * 86_400) {
    throw new Error("Forward-audit epoch window is invalid or exceeds 14 days.");
  }
  const directory = symbolDataDirectory(root, symbol);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.symbol !== symbol || !Array.isArray(manifest.chunks)) {
    throw new Error("Tick manifest version, symbol, or chunk list is invalid.");
  }
  const expectedRows = toEpochExclusive - fromEpoch;
  const marks = new Uint8Array(expectedRows);
  const quotes = new Float64Array(expectedRows);
  let verifiedChunks = 0;
  let rowsRead = 0;
  let observedWindowRows = 0;
  let duplicateRows = 0;
  let conflictingRows = 0;
  for (const chunk of manifest.chunks) {
    if (!Number.isSafeInteger(chunk.firstEpoch) || !Number.isSafeInteger(chunk.lastEpoch) || !Number.isSafeInteger(chunk.rows) || chunk.rows < 1 || chunk.lastEpoch < chunk.firstEpoch || !/^[a-f0-9]{64}$/i.test(chunk.sha256 ?? "")) {
      throw new Error("Tick manifest contains invalid chunk metadata.");
    }
    if (chunk.lastEpoch < fromEpoch || chunk.firstEpoch >= toEpochExclusive) continue;
    if (typeof chunk.file !== "string") throw new Error("Tick manifest contains an invalid chunk path.");
    const absoluteFile = path.resolve(directory, chunk.file);
    if (!absoluteFile.startsWith(`${directory}${path.sep}`)) {
      throw new Error("Tick chunk path escapes its symbol archive.");
    }
    const compressed = await readFile(absoluteFile);
    const digest = createHash("sha256").update(compressed).digest("hex");
    if (digest !== chunk.sha256.toLowerCase()) {
      throw new Error(`Tick archive checksum failed for ${chunk.file}.`);
    }
    const lines = gunzipSync(compressed).toString("utf8").split("\n");
    let firstInChunk = null;
    let lastInChunk = null;
    let rowsInChunk = 0;
    for (const line of lines) {
      if (!line) continue;
      const tick = JSON.parse(line);
      if (!Number.isSafeInteger(tick.epoch) || tick.epoch < 1 || !Number.isFinite(tick.quote)) {
        throw new Error(`Tick chunk ${chunk.file} contains an invalid row.`);
      }
      if (lastInChunk !== null && tick.epoch < lastInChunk) {
        throw new Error(`Tick chunk ${chunk.file} is not ordered by epoch.`);
      }
      firstInChunk ??= tick.epoch;
      lastInChunk = tick.epoch;
      rowsInChunk += 1;
      if (tick.epoch < fromEpoch || tick.epoch >= toEpochExclusive) continue;
      observedWindowRows += 1;
      const offset = tick.epoch - fromEpoch;
      if (marks[offset] !== 0) {
        duplicateRows += 1;
        if (quotes[offset] !== tick.quote) {
          conflictingRows += 1;
          marks[offset] = 3;
        } else if (marks[offset] !== 3) {
          marks[offset] = 2;
        }
      } else {
        marks[offset] = 1;
        quotes[offset] = tick.quote;
      }
    }
    if (rowsInChunk !== chunk.rows || firstInChunk !== chunk.firstEpoch || lastInChunk !== chunk.lastEpoch) {
      throw new Error(`Tick chunk ${chunk.file} row count or epoch bounds disagree with its manifest metadata.`);
    }
    verifiedChunks += 1;
    rowsRead += rowsInChunk;
  }
  const missingRanges = rangesFromMarks(marks, fromEpoch, (mark) => mark === 0);
  const duplicateRanges = rangesFromMarks(marks, fromEpoch, (mark) => mark >= 2);
  const conflictingRanges = rangesFromMarks(marks, fromEpoch, (mark) => mark === 3);
  const missingRows = missingRanges.reduce((sum, range) => sum + range.lastEpoch - range.firstEpoch + 1, 0);
  const availableRows = expectedRows - missingRows;
  const coverageRate = availableRows / expectedRows;
  const state = duplicateRows > 0 || conflictingRows > 0
    ? "FAILED"
    : coverageRate < MINIMUM_COVERAGE
      ? "INCONCLUSIVE"
      : missingRows > 0
        ? "PASS_WITH_GAPS"
        : "COMPLETE";
  return {
    kind: "public-forward-window-row-audit",
    symbol,
    fromEpoch,
    toEpochExclusive,
    fromUtcInclusive: new Date(fromEpoch * 1000).toISOString(),
    toUtcExclusive: new Date(toEpochExclusive * 1000).toISOString(),
    minimumCoverageRate: MINIMUM_COVERAGE,
    state,
    expectedRows,
    availableRows,
    missingRows,
    coverageRate,
    missingRanges,
    duplicateRows,
    duplicateRanges,
    conflictingRows,
    conflictingRanges,
    observedWindowRows,
    verifiedChunks,
    rowsRead,
    note: "A passing archive audit verifies stored public ticks only; it does not establish an executable quote, a profitable method, or permission to trade.",
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameStatusFileWithRetry(temporary, filePath);
}

async function run() {
  const options = parseForwardAuditArgs(process.argv.slice(2));
  const reportPath = path.join(projectRoot, "data", "reports", `forward-audit-${options.symbol}-${options.fromEpoch}-${options.toEpochExclusive}.json`);
  let report;
  try {
    report = await auditForwardWindow({ projectRoot, ...options });
  } catch (error) {
    report = {
      kind: "public-forward-window-row-audit",
      state: "FAILED",
      ...options,
      error: error.message,
    };
  }
  report.auditedAtUtc = new Date().toISOString();
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({ reportPath, state: report.state, availableRows: report.availableRows ?? null, expectedRows: report.expectedRows ?? null, missingRows: report.missingRows ?? null }));
  if (!["COMPLETE", "PASS_WITH_GAPS"].includes(report.state)) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
