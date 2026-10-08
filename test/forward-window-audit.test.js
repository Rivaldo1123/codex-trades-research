import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { auditForwardWindow, parseForwardAuditArgs } from "../src/forward-window-audit-cli.js";

async function fixture(chunks) {
  const root = await mkdtemp(path.join(tmpdir(), "forward-audit-"));
  const directory = path.join(root, "data", "market", "1HZ100V");
  await mkdir(path.join(directory, "raw"), { recursive: true });
  const manifest = { version: 1, symbol: "1HZ100V", chunks: [] };
  for (let i = 0; i < chunks.length; i += 1) {
    const rows = chunks[i];
    const file = `raw/chunk-${i}.jsonl.gz`;
    const compressed = gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await writeFile(path.join(directory, file), compressed);
    manifest.chunks.push({
      file,
      firstEpoch: rows[0].epoch,
      lastEpoch: rows.at(-1).epoch,
      rows: rows.length,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    });
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { root, directory };
}

test("forward audit parses an exact bounded UTC window", () => {
  assert.deepEqual(parseForwardAuditArgs(["run", "--from", "2026-10-07T15:48:00Z", "--to", "2026-10-21T15:47:00Z", "--symbol", "1HZ100V"]), {
    fromEpoch: 1791388080,
    toEpochExclusive: 1792597620,
    symbol: "1HZ100V",
  });
  assert.throws(() => parseForwardAuditArgs(["run", "--from", "2026-10-21T15:47:00Z", "--to", "2026-10-07T15:48:00Z", "--symbol", "1HZ100V"]), /positive/);
});

test("row-level forward audit ignores a historical gap outside its exact window", async () => {
  const { root } = await fixture([
    [{ epoch: 90, quote: 1 }, { epoch: 92, quote: 2 }],
    Array.from({ length: 10 }, (_, i) => ({ epoch: 100 + i, quote: 100 + i })),
  ]);
  try {
    const result = await auditForwardWindow({ projectRoot: root, symbol: "1HZ100V", fromEpoch: 100, toEpochExclusive: 110 });
    assert.equal(result.state, "COMPLETE");
    assert.equal(result.availableRows, 10);
    assert.equal(result.verifiedChunks, 1);
    assert.deepEqual(result.missingRanges, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("row-level audit reports missing boundary and interior seconds and fails below 99.9%", async () => {
  const { root } = await fixture([[{ epoch: 101, quote: 1 }, { epoch: 103, quote: 3 }, { epoch: 108, quote: 8 }]]);
  try {
    const result = await auditForwardWindow({ projectRoot: root, symbol: "1HZ100V", fromEpoch: 100, toEpochExclusive: 110 });
    assert.equal(result.state, "INCONCLUSIVE");
    assert.equal(result.availableRows, 3);
    assert.equal(result.missingRows, 7);
    assert.deepEqual(result.missingRanges, [
      { firstEpoch: 100, lastEpoch: 100 },
      { firstEpoch: 102, lastEpoch: 102 },
      { firstEpoch: 104, lastEpoch: 107 },
      { firstEpoch: 109, lastEpoch: 109 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("row-level audit reports duplicate and conflicting epochs even with full coverage", async () => {
  const { root } = await fixture([
    [{ epoch: 100, quote: 1 }, { epoch: 101, quote: 2 }],
    [{ epoch: 100, quote: 1 }, { epoch: 101, quote: 20 }, { epoch: 102, quote: 3 }],
  ]);
  try {
    const result = await auditForwardWindow({ projectRoot: root, symbol: "1HZ100V", fromEpoch: 100, toEpochExclusive: 103 });
    assert.equal(result.state, "FAILED");
    assert.equal(result.duplicateRows, 2);
    assert.equal(result.conflictingRows, 1);
    assert.deepEqual(result.duplicateRanges, [{ firstEpoch: 100, lastEpoch: 101 }]);
    assert.deepEqual(result.conflictingRanges, [{ firstEpoch: 101, lastEpoch: 101 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksum changes fail the forward audit", async () => {
  const { root, directory } = await fixture([[{ epoch: 100, quote: 1 }]]);
  try {
    const chunkPath = path.join(directory, "raw", "chunk-0.jsonl.gz");
    const contents = await readFile(chunkPath);
    contents[contents.length - 1] ^= 1;
    await writeFile(chunkPath, contents);
    await assert.rejects(() => auditForwardWindow({ projectRoot: root, symbol: "1HZ100V", fromEpoch: 100, toEpochExclusive: 101 }), /checksum/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
