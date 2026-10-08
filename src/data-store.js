import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const MANIFEST_VERSION = 1;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeTicks(ticks) {
  const unique = new Map();
  for (const tick of ticks) {
    const epoch = Number(tick.epoch);
    const quote = Number(tick.quote);
    if (!Number.isInteger(epoch) || epoch < 1 || !Number.isFinite(quote)) {
      throw new Error("Cannot archive a tick with an invalid epoch or quote.");
    }
    const previous = unique.get(epoch);
    if (previous !== undefined && previous !== quote) {
      throw new Error(`Conflicting quotes received for epoch ${epoch}.`);
    }
    unique.set(epoch, quote);
  }
  return [...unique.entries()]
    .map(([epoch, quote]) => ({ epoch, quote }))
    .sort((a, b) => a.epoch - b.epoch);
}

export function symbolDataDirectory(projectRoot, symbol) {
  if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
    throw new Error("Symbol has an invalid format.");
  }
  return path.join(projectRoot, "data", "market", symbol);
}

export async function readManifest(projectRoot, symbol) {
  const directory = symbolDataDirectory(projectRoot, symbol);
  const manifestPath = path.join(directory, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== MANIFEST_VERSION || manifest.symbol !== symbol) {
      throw new Error("Tick archive manifest has an unsupported format.");
    }
    if (!Array.isArray(manifest.chunks)) {
      throw new Error("Tick archive manifest does not contain a chunk list.");
    }
    return manifest;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return {
      version: MANIFEST_VERSION,
      symbol,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      chunks: [],
    };
  }
}

async function writeManifest(projectRoot, manifest) {
  const directory = symbolDataDirectory(projectRoot, manifest.symbol);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "manifest.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function coverageIntervals(chunks) {
  const sorted = chunks
    .map((chunk) => ({ firstEpoch: chunk.firstEpoch, lastEpoch: chunk.lastEpoch }))
    .sort((a, b) => a.firstEpoch - b.firstEpoch);
  const intervals = [];
  for (const range of sorted) {
    const previous = intervals.at(-1);
    if (!previous || range.firstEpoch > previous.lastEpoch + 1) {
      intervals.push({ ...range });
    } else {
      previous.lastEpoch = Math.max(previous.lastEpoch, range.lastEpoch);
    }
  }
  return intervals;
}

export function filterUncoveredTicks(ticks, chunks) {
  const intervals = coverageIntervals(chunks);
  return normalizeTicks(ticks).filter((tick) => {
    return !intervals.some(
      (range) => tick.epoch >= range.firstEpoch && tick.epoch <= range.lastEpoch,
    );
  });
}

export async function appendTickChunk(
  projectRoot,
  symbol,
  ticks,
  {
    request = null,
    retrievedAt = new Date().toISOString(),
    source = "Deriv public ticks_history",
  } = {},
) {
  const normalized = normalizeTicks(ticks);
  if (normalized.length === 0) {
    return { manifest: await readManifest(projectRoot, symbol), chunk: null };
  }

  const lines = normalized.map((tick) => JSON.stringify(tick)).join("\n") + "\n";
  const compressed = gzipSync(Buffer.from(lines, "utf8"), { level: 9 });
  const digest = sha256(compressed);
  const firstEpoch = normalized[0].epoch;
  const lastEpoch = normalized.at(-1).epoch;
  const relativeFile = path.join(
    "raw",
    `ticks-${firstEpoch}-${lastEpoch}-${normalized.length}-${digest.slice(0, 12)}.jsonl.gz`,
  );
  const directory = symbolDataDirectory(projectRoot, symbol);
  const absoluteFile = path.join(directory, relativeFile);
  await mkdir(path.dirname(absoluteFile), { recursive: true });

  try {
    await readFile(absoluteFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await writeFile(absoluteFile, compressed, { flag: "wx" });
  }

  const manifest = await readManifest(projectRoot, symbol);
  const existing = manifest.chunks.find((chunk) => chunk.sha256 === digest);
  if (existing) {
    return { manifest, chunk: existing };
  }

  const chunk = {
    file: relativeFile.replaceAll("\\", "/"),
    firstEpoch,
    lastEpoch,
    rows: normalized.length,
    sha256: digest,
    request,
    retrievedAt,
    source,
    storedAt: new Date().toISOString(),
  };
  manifest.chunks.push(chunk);
  manifest.chunks.sort((a, b) => a.firstEpoch - b.firstEpoch);
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(projectRoot, manifest);
  return { manifest, chunk };
}

export function summarizeManifest(manifest) {
  const intervals = coverageIntervals(manifest.chunks);
  const totalRows = manifest.chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
  const firstEpoch = intervals[0]?.firstEpoch ?? null;
  const lastEpoch = intervals.at(-1)?.lastEpoch ?? null;
  const internalGaps = intervals.slice(1).map((range, index) => ({
    firstMissingEpoch: intervals[index].lastEpoch + 1,
    lastMissingEpoch: range.firstEpoch - 1,
  }));
  return {
    chunks: manifest.chunks.length,
    coverageDays:
      firstEpoch === null ? 0 : (lastEpoch - firstEpoch + 1) / 86_400,
    firstEpoch,
    internalGaps,
    intervals: intervals.length,
    lastEpoch,
    totalRows,
  };
}

export async function loadArchivedTicks(
  projectRoot,
  symbol,
  { maxRows = Infinity, verifyHashes = true } = {},
) {
  const manifest = await readManifest(projectRoot, symbol);
  let selected = manifest.chunks;
  if (Number.isFinite(maxRows)) {
    let rows = 0;
    let start = selected.length;
    while (start > 0 && rows < maxRows) {
      start -= 1;
      rows += selected[start].rows;
    }
    selected = selected.slice(start);
  }

  const byEpoch = new Map();
  const directory = symbolDataDirectory(projectRoot, symbol);
  for (const chunk of selected) {
    const compressed = await readFile(path.join(directory, chunk.file));
    if (verifyHashes && sha256(compressed) !== chunk.sha256) {
      throw new Error(`Tick archive checksum failed for ${chunk.file}.`);
    }
    const content = gunzipSync(compressed).toString("utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      const tick = JSON.parse(line);
      const previous = byEpoch.get(tick.epoch);
      if (previous !== undefined && previous !== tick.quote) {
        throw new Error(`Archived quote conflict at epoch ${tick.epoch}.`);
      }
      byEpoch.set(tick.epoch, tick.quote);
    }
  }

  const ticks = [...byEpoch.entries()]
    .map(([epoch, quote]) => ({ epoch: Number(epoch), quote: Number(quote) }))
    .sort((a, b) => a.epoch - b.epoch);
  return Number.isFinite(maxRows) ? ticks.slice(-maxRows) : ticks;
}
