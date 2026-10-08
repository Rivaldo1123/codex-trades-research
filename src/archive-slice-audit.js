import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { symbolDataDirectory } from "./data-store.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateBounds({ fromEpoch, toEpochExclusive }) {
  if (!Number.isSafeInteger(fromEpoch) || !Number.isSafeInteger(toEpochExclusive) ||
      toEpochExclusive <= fromEpoch) {
    throw new Error("Archive slice boundaries must be increasing integer epochs.");
  }
}

function relevantChunks(manifest, fromEpoch, toEpochExclusive) {
  return manifest.chunks
    .filter((chunk) =>
      chunk.lastEpoch >= fromEpoch && chunk.firstEpoch < toEpochExclusive)
    .map((chunk) => ({
      file: chunk.file,
      firstEpoch: chunk.firstEpoch,
      lastEpoch: chunk.lastEpoch,
      request: chunk.request ?? null,
      retrievedAt: chunk.retrievedAt ?? null,
      rows: chunk.rows,
      sha256: chunk.sha256,
      source: chunk.source ?? null,
    }))
    .sort((left, right) =>
      left.firstEpoch - right.firstEpoch ||
      left.lastEpoch - right.lastEpoch ||
      String(left.file).localeCompare(String(right.file)));
}

function validateManifest(manifest, symbol) {
  if (manifest?.version !== 1 || manifest.symbol !== symbol ||
      !Array.isArray(manifest.chunks)) {
    throw new Error("Archive manifest format or symbol is invalid.");
  }
}

function descriptorHash({ fromEpoch, symbol, toEpochExclusive }, chunks) {
  return sha256(JSON.stringify({
    chunks,
    fromEpochInclusive: fromEpoch,
    schemaVersion: 1,
    symbol,
    toEpochExclusive,
  }));
}

function missingRanges(present, fromEpoch) {
  const ranges = [];
  for (let index = 0; index < present.length;) {
    if (present[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < present.length && !present[index]) index += 1;
    ranges.push({
      fromEpoch: fromEpoch + start,
      missingSeconds: index - start,
      toEpochExclusive: fromEpoch + index,
    });
  }
  return ranges;
}

function contentHash({ fromEpoch, symbol, toEpochExclusive }, quotes, present) {
  const hash = createHash("sha256");
  hash.update(`archive-slice-v1\n${symbol}\n${fromEpoch}\n${toEpochExclusive}\n`);
  let buffer = "";
  for (let index = 0; index < present.length; index += 1) {
    buffer += present[index]
      ? `${fromEpoch + index}\t${quotes[index]}\n`
      : `${fromEpoch + index}\tMISSING\n`;
    if (buffer.length >= 1_000_000) {
      hash.update(buffer);
      buffer = "";
    }
  }
  if (buffer) hash.update(buffer);
  return hash.digest("hex");
}

export async function auditArchiveSlice({
  projectRoot,
  symbol,
  fromEpoch,
  toEpochExclusive,
}) {
  validateBounds({ fromEpoch, toEpochExclusive });
  const directory = symbolDataDirectory(projectRoot, symbol);
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(manifest, symbol);
  const selected = relevantChunks(manifest, fromEpoch, toEpochExclusive);
  const sliceManifestSha256 = descriptorHash(
    { fromEpoch, symbol, toEpochExclusive },
    selected,
  );
  const slots = toEpochExclusive - fromEpoch;
  const quotes = new Float64Array(slots);
  const present = new Uint8Array(slots);
  let observedGenuineSeconds = 0;

  for (const chunk of selected) {
    if (!Number.isSafeInteger(chunk.firstEpoch) ||
        !Number.isSafeInteger(chunk.lastEpoch) ||
        !Number.isSafeInteger(chunk.rows) || chunk.rows < 1 ||
        chunk.firstEpoch > chunk.lastEpoch ||
        !/^[a-f0-9]{64}$/.test(chunk.sha256 ?? "") ||
        typeof chunk.file !== "string") {
      throw new Error("Archive slice contains invalid chunk metadata.");
    }
    const chunkPath = path.resolve(directory, chunk.file);
    if (!chunkPath.startsWith(`${directory}${path.sep}`)) {
      throw new Error("Archive slice chunk path escapes the symbol directory.");
    }
    const compressed = await readFile(chunkPath);
    if (sha256(compressed) !== chunk.sha256) {
      throw new Error(`Archive slice checksum failed for ${chunk.file}.`);
    }
    const lines = gunzipSync(compressed).toString("utf8").trimEnd().split("\n");
    if (lines.length !== chunk.rows) {
      throw new Error(`Archive slice row count failed for ${chunk.file}.`);
    }
    let first = null;
    let last = null;
    for (const line of lines) {
      const tick = JSON.parse(line);
      if (!Number.isSafeInteger(tick.epoch) || !Number.isFinite(tick.quote) ||
          (last !== null && tick.epoch <= last)) {
        throw new Error(`Archive slice has an invalid row in ${chunk.file}.`);
      }
      first ??= tick.epoch;
      last = tick.epoch;
      if (tick.epoch < fromEpoch || tick.epoch >= toEpochExclusive) continue;
      const index = tick.epoch - fromEpoch;
      if (present[index]) {
        throw new Error(`Archive slice has duplicate evidence at epoch ${tick.epoch}.`);
      }
      present[index] = 1;
      quotes[index] = tick.quote;
      observedGenuineSeconds += 1;
    }
    if (first !== chunk.firstEpoch || last !== chunk.lastEpoch) {
      throw new Error(`Archive slice bounds failed for ${chunk.file}.`);
    }
  }

  const finalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(finalManifest, symbol);
  const finalRelevantHash = descriptorHash(
    { fromEpoch, symbol, toEpochExclusive },
    relevantChunks(finalManifest, fromEpoch, toEpochExclusive),
  );
  if (finalRelevantHash !== sliceManifestSha256) {
    throw new Error("Relevant archive slice changed during audit.");
  }
  const ranges = missingRanges(present, fromEpoch);
  return {
    audit: {
      checks: "Independent chunk checksum, row count, bounds, ordering, duplicate rejection, stable relevant manifest, and exact chronological content hash.",
      contentSha256: contentHash(
        { fromEpoch, symbol, toEpochExclusive },
        quotes,
        present,
      ),
      coverage: observedGenuineSeconds / slots,
      expectedSeconds: slots,
      fromEpoch,
      manifestSnapshotSha256: sha256(manifestBytes),
      missingRanges: ranges,
      missingSeconds: slots - observedGenuineSeconds,
      observedGenuineSeconds,
      selectedChunks: selected.length,
      sliceManifestSha256,
      symbol,
      toEpochExclusive,
    },
    present,
    quotes,
  };
}
