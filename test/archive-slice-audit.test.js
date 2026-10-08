import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditArchiveSlice } from "../src/archive-slice-audit.js";
import { appendTickChunk } from "../src/data-store.js";

test("slice provenance stays stable when an unrelated backfill extends the manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-slice-audit-"));
  try {
    const fromEpoch = 1_700_000_000;
    const ticks = Array.from({ length: 10 }, (_, index) => ({
      epoch: fromEpoch + index,
      quote: 100 + index / 10,
    })).filter((tick) => tick.epoch !== fromEpoch + 4);
    await appendTickChunk(root, "1HZ100V", ticks);
    const input = {
      fromEpoch,
      projectRoot: root,
      symbol: "1HZ100V",
      toEpochExclusive: fromEpoch + 10,
    };
    const before = await auditArchiveSlice(input);
    await appendTickChunk(root, "1HZ100V", [
      { epoch: fromEpoch - 2, quote: 99.8 },
      { epoch: fromEpoch - 1, quote: 99.9 },
    ]);
    const after = await auditArchiveSlice(input);
    assert.notEqual(
      before.audit.manifestSnapshotSha256,
      after.audit.manifestSnapshotSha256,
    );
    assert.equal(before.audit.sliceManifestSha256, after.audit.sliceManifestSha256);
    assert.equal(before.audit.contentSha256, after.audit.contentSha256);
    assert.equal(after.audit.observedGenuineSeconds, 9);
    assert.deepEqual(after.audit.missingRanges, [{
      fromEpoch: fromEpoch + 4,
      missingSeconds: 1,
      toEpochExclusive: fromEpoch + 5,
    }]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("slice audit rejects overlapping archived evidence independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-slice-overlap-"));
  try {
    const fromEpoch = 1_700_000_000;
    await appendTickChunk(root, "1HZ100V", [
      { epoch: fromEpoch, quote: 100 },
      { epoch: fromEpoch + 1, quote: 101 },
    ]);
    await appendTickChunk(root, "1HZ100V", [
      { epoch: fromEpoch + 1, quote: 101 },
      { epoch: fromEpoch + 2, quote: 102 },
    ]);
    await assert.rejects(auditArchiveSlice({
      fromEpoch,
      projectRoot: root,
      symbol: "1HZ100V",
      toEpochExclusive: fromEpoch + 3,
    }), /duplicate evidence/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
