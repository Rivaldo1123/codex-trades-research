import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PUBLIC_ENDPOINT } from "../src/deriv-public.js";
import { captureRetrospectivePilotGaps, verifyHistoricalGapResponse } from
  "../src/retrospective-pilot-recovery.js";

test("retrospective gap recovery requires matching live boundary quotes", () => {
  const live = [{ epoch: 99, quote: 10 }, { epoch: 102, quote: 13 }];
  const history = [{ epoch: 99, quote: 10 }, { epoch: 100, quote: 11 },
    { epoch: 101, quote: 12 }, { epoch: 102, quote: 13 }];
  assert.deepEqual(verifyHistoricalGapResponse(live, history,
    { firstEpoch: 100, lastEpoch: 101 }), {
    recovered: history.slice(1, 3), stillMissing: [],
  });
  assert.deepEqual(verifyHistoricalGapResponse(live,
    history.filter((tick) => tick.epoch !== 101),
    { firstEpoch: 100, lastEpoch: 101 }), {
    recovered: [{ epoch: 100, quote: 11 }], stillMissing: [101],
  });
  assert.throws(() => verifyHistoricalGapResponse(live,
    history.map((tick) => tick.epoch === 102 ? { ...tick, quote: 99 } : tick),
    { firstEpoch: 100, lastEpoch: 101 }), /conflicts with live quote/);
  assert.throws(() => verifyHistoricalGapResponse(live,
    history.filter((tick) => tick.epoch !== 99),
    { firstEpoch: 100, lastEpoch: 101 }), /boundary tick/);
});

test("changed public-only configuration prevents historical requests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retrospective-pilot-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data", "market"), { recursive: true });
  const sourceProtocol = path.resolve("data", "market",
    "forward-protocol-2026-10-07-v3-pilot.json");
  await writeFile(path.join(root, "data", "market",
    "forward-protocol-2026-10-07-v3-pilot.json"), await readFile(sourceProtocol));
  await writeFile(path.join(root, "config.data.json"), JSON.stringify({
    mode: "demo", endpoint: PUBLIC_ENDPOINT, symbol: "1HZ100V",
  }));
  let called = false;
  const client = { endpoint: PUBLIC_ENDPOINT, async connect() { called = true; }, close() {} };
  await assert.rejects(captureRetrospectivePilotGaps({ projectRoot: root, client,
    nowMs: Date.parse("2026-10-08T01:00:00Z") }), /safety lock/);
  assert.equal(called, false);
});
