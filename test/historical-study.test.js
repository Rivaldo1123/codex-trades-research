import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendTickChunk } from "../src/data-store.js";
import {
  IncompleteHistoricalWindowError,
  createHistoricalStudyReport,
  loadExactArchivedWindow,
  parseCliArgs,
  runHistoricalStudy,
} from "../src/historical-study.js";

const symbol = "1HZ100V";
const fromEpoch = 1_700_000_000;

function risingTicks(count, omitted = new Set()) {
  return Array.from({ length: count }, (_, index) => ({
    epoch: fromEpoch + index,
    quote: 100 + index * 0.01,
  })).filter((tick) => !omitted.has(tick.epoch));
}

async function withArchive(ticks, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "historical-study-test-"));
  try {
    const { chunk } = await appendTickChunk(root, symbol, ticks);
    return await callback(root, chunk);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the completed offline study selects on validation and tests only the selected Bot flow", async () => {
  await withArchive(risingTicks(300), async (root) => {
    const { report, reportPath } = await runHistoricalStudy({
      projectRoot: root,
      symbol,
      fromEpoch,
      toEpoch: fromEpoch + 300,
    });
    assert.equal(path.dirname(reportPath), path.join(root, "data", "reports"));
    assert.equal(report.selection.selectedId, "one-tick-rise-signal");
    assert.equal(report.candidates.length, 2);
    assert.ok(report.candidates.every((candidate) => !("test" in candidate)));
    assert.equal(report.untouchedTest.candidateId, report.selection.selectedId);
    assert.equal(report.untouchedTest.observations, 43);
    assert.equal(report.untouchedTest.winRate, 1);
    assert.equal(report.untouchedTest.profitFactor, null);
    assert.equal(report.split.train.toEpochExclusive, fromEpoch + 210);
    assert.equal(report.split.validation.toEpochExclusive, fromEpoch + 255);
    assert.equal(report.candidates[0].training.observations, 189);
    assert.equal(report.candidates[0].validation.observations, 43);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
  });
});

test("changing the untouched test prices cannot change validation selection", () => {
  const original = risingTicks(300);
  const changed = original.map((tick, index) => ({
    ...tick,
    quote: index < 255 ? tick.quote : original[254].quote - (index - 254) * 0.01,
  }));
  const inputs = { symbol, fromEpoch, toEpoch: fromEpoch + 300, archive: {} };
  const first = createHistoricalStudyReport({ ...inputs, ticks: original });
  const second = createHistoricalStudyReport({ ...inputs, ticks: changed });
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.selection, second.selection);
  assert.notEqual(first.untouchedTest.winRate, second.untouchedTest.winRate);
});

test("a missing second inside one manifest chunk fails INCOMPLETE without a report", async () => {
  const omitted = new Set([fromEpoch + 100]);
  await withArchive(risingTicks(300, omitted), async (root) => {
    await assert.rejects(
      runHistoricalStudy({
        projectRoot: root,
        symbol,
        fromEpoch,
        toEpoch: fromEpoch + 300,
      }),
      (error) => {
        assert.ok(error instanceof IncompleteHistoricalWindowError);
        assert.equal(error.code, "INCOMPLETE");
        assert.equal(error.details.missingTicks, 1);
        assert.deepEqual(error.details.gaps[0], {
          fromEpoch: fromEpoch + 100,
          toEpochExclusive: fromEpoch + 101,
          missingTicks: 1,
        });
        return true;
      },
    );
    await assert.rejects(readdir(path.join(root, "data", "reports")), { code: "ENOENT" });
  });
});

test("a changed compressed chunk fails checksum verification", async () => {
  await withArchive(risingTicks(300), async (root, chunk) => {
    const chunkPath = path.join(root, "data", "market", symbol, chunk.file);
    const bytes = await readFile(chunkPath);
    bytes[0] ^= 1;
    await writeFile(chunkPath, bytes);
    await assert.rejects(
      loadExactArchivedWindow({
        projectRoot: root,
        symbol,
        fromEpoch,
        toEpoch: fromEpoch + 300,
      }),
      /checksum failed/,
    );
  });
});

test("the command requires explicit integer window bounds and a symbol", () => {
  assert.deepEqual(
    parseCliArgs(["--from", "1790049600", "--to", "1791259200", "--symbol", symbol]),
    { fromEpoch: 1_790_049_600, toEpoch: 1_791_259_200, symbol },
  );
  assert.throws(() => parseCliArgs(["--from", "1", "--to", "2"]), /Usage/);
  assert.throws(
    () => parseCliArgs(["--from", "1", "--to", "2", "--symbol", symbol, "--extra", "3"]),
    /Usage/,
  );
});
