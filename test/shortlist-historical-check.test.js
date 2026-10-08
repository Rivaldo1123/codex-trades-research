import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { auditShortlistPages, oneMinuteReplayDiagnostics, SHORTLIST_PROTOCOL_SHA256,
  validateShortlistProtocol } from "../src/shortlist-historical-check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("shortlist protocol is frozen to three public-only candidates and an unseen historical window", async () => {
  const bytes = await readFile(path.join(root, "data", "market",
    "shortlist-historical-check-v1.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    SHORTLIST_PROTOCOL_SHA256);
  const protocol = validateShortlistProtocol(JSON.parse(bytes));
  assert.equal(protocol.candidates.length, 3);
  assert.equal(protocol.botBuilderRunPermission, false);
  assert.throws(() => validateShortlistProtocol({ ...protocol,
    endpoint: "wss://api.derivws.com/trading/v1/options/ws/demo" }), /protocol changed/);
  assert.throws(() => validateShortlistProtocol({ ...protocol,
    candidates: protocol.candidates.slice(1) }), /protocol changed/);
  assert.throws(() => validateShortlistProtocol({ ...protocol,
    botBuilderRunPermission: true }), /protocol changed/);
});

test("one-minute replay runs every tick but never carries an open contract across minutes", () => {
  const quotes = Float64Array.from(Array.from({ length: 120 }, (_, index) => index));
  const present = Uint8Array.from(Array(120).fill(1));
  const signals = Uint8Array.from(Array(120).fill(1));
  const result = oneMinuteReplayDiagnostics({ quotes, present, signals,
    fromEpoch: 1_700_000_040, secondsPerTick: 1, delayTicks: 1 });
  assert.equal(result.minutesTested, 2);
  assert.equal(result.activeMinutes, 2);
  assert.equal(result.positiveMinutes, 2);
  assert.equal(result.totalWins, result.totalTrades);
  assert.equal(result.minutes[1].fromEpoch, 1_700_000_100);
});

test("shortlist audit preserves missing ticks and rejects overlap or wrong cadence", async () => {
  const protocol = validateShortlistProtocol(JSON.parse(await readFile(path.join(root,
    "data", "market", "shortlist-historical-check-v1.json"))));
  const spec = protocol.candidates[0];
  const pages = [{ ticks: [[protocol.fromEpoch, 100], [protocol.fromEpoch + 4, 101]],
    rows: 2 }];
  const audit = auditShortlistPages(pages, spec, protocol);
  assert.equal(audit.observedTicks, 2);
  assert.equal(audit.missingRanges[0].missingTicks, 1);
  assert.equal(audit.state, "INCOMPLETE");
  assert.throws(() => auditShortlistPages([{ ticks: [[protocol.fromEpoch + 1, 100]] }],
    spec, protocol), /cadence/);
});
