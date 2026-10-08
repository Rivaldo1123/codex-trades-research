import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWatchdogSnapshot,
  parseWatchdogArgs,
} from "../src/live-watchdog-cli.js";

const until = "2026-10-21T01:50:14.257Z";
const startedAt = "2026-10-07T01:50:25.386Z";
const expected = { pid: 12345, symbol: "1HZ100V", until, protocol: "data/market/forward-protocol-2026-10-07.json", protocolSha256: null };
const config = {
  mode: "public-data-only",
  endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
  symbol: "1HZ100V",
};
const limits = {
  startupGraceMs: 10_000,
  staleStatusMs: 1_000,
  noProgressMs: 2_000,
  finishGraceMs: 2_000,
};

function tracker(nowMs = 100_000) {
  return {
    startedAtMs: nowMs,
    collectorStartedAt: null,
    firstRunningAtMs: null,
    lastProgressAtMs: null,
    lastTickEpoch: null,
    ticksReceived: null,
  };
}

function snapshot(nowMs, overrides = {}) {
  return {
    config,
    expected,
    lockPid: expected.pid,
    processAlive: true,
    status: {
      state: "RUNNING",
      pid: expected.pid,
      startedAt,
      endsAt: until,
      endpoint: config.endpoint,
      mode: config.mode,
      symbol: config.symbol,
      ticksReceived: 1,
      lastTickEpoch: 1_791_333_600,
      updatedAt: new Date(nowMs).toISOString(),
    },
    ...overrides,
  };
}

test("watchdog arguments require exact PID, UTC end, and symbol", () => {
  assert.deepEqual(parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V"]), expected);
  assert.equal(parseWatchdogArgs(["run", "--pid", "12345", "--until", "2026-10-21T15:47:00Z", "--symbol", "1HZ100V"]).until, "2026-10-21T15:47:00.000Z");
  assert.throws(() => parseWatchdogArgs(["run", "--pid", "0", "--until", until, "--symbol", "1HZ100V"]), /positive/);
  assert.throws(() => parseWatchdogArgs(["run", "--pid", "12345", "--until", "tomorrow", "--symbol", "1HZ100V"]), /ISO/);
  assert.throws(() => parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V", "--pid", "12345"]), /Usage|repeated/);
  const withProtocol = parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V", "--protocol-sha256", "A".repeat(64)]);
  assert.equal(withProtocol.protocolSha256, "a".repeat(64));
  const v2 = parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V", "--protocol", "data/market/forward-protocol-2026-10-07-v2.json", "--protocol-sha256", "A".repeat(64)]);
  assert.equal(v2.protocol, "data/market/forward-protocol-2026-10-07-v2.json");
  assert.throws(() => parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V", "--protocol", "data/market/../secret.json"]), /protocol path/);
  assert.throws(() => parseWatchdogArgs(["run", "--pid", "12345", "--until", until, "--symbol", "1HZ100V", "--protocol-sha256", "x"]), /SHA-256/);
});

test("watchdog waits for a new collector status but fails if process dies", () => {
  const nowMs = 100_000;
  assert.equal(evaluateWatchdogSnapshot(snapshot(nowMs, { status: null, lockPid: null }), tracker(nowMs), nowMs, limits).state, "WAITING_START");
  assert.match(evaluateWatchdogSnapshot(snapshot(nowMs, { processAlive: false }), tracker(nowMs), nowMs, limits).reason, /exited/);
});

test("watchdog enforces endpoint, lock, status heartbeat, and collector identity", () => {
  const nowMs = 100_000;
  assert.match(evaluateWatchdogSnapshot(snapshot(nowMs, { config: { ...config, endpoint: "wss://example.invalid" } }), tracker(nowMs), nowMs, limits).reason, /configuration/);
  assert.match(evaluateWatchdogSnapshot(snapshot(nowMs, { lockPid: 999 }), tracker(nowMs), nowMs, limits).reason, /lock/);
  const stale = snapshot(nowMs);
  stale.status.updatedAt = new Date(nowMs - 2_000).toISOString();
  assert.match(evaluateWatchdogSnapshot(stale, tracker(nowMs), nowMs, limits).reason, /stale/);
  const mismatched = snapshot(nowMs);
  mismatched.status.endsAt = "2026-10-20T01:50:14.257Z";
  assert.match(evaluateWatchdogSnapshot(mismatched, tracker(nowMs), nowMs, limits).reason, /identity/);
  const expectedWithProtocol = { ...expected, protocolSha256: "a".repeat(64) };
  assert.match(evaluateWatchdogSnapshot(snapshot(nowMs, { expected: expectedWithProtocol, protocolSha256: "b".repeat(64) }), tracker(nowMs), nowMs, limits).reason, /protocol SHA-256/);
});

test("watchdog detects no tick progress without relying on archive interval summaries", () => {
  const nowMs = 100_000;
  const first = evaluateWatchdogSnapshot(snapshot(nowMs), tracker(nowMs), nowMs, limits);
  assert.equal(first.state, "WATCHING");
  const stalled = evaluateWatchdogSnapshot(snapshot(nowMs + 2_000), first.tracker, nowMs + 2_000, limits);
  assert.equal(stalled.state, "FAILED");
  assert.match(stalled.reason, /No advancing public tick/);
  const advancedSnapshot = snapshot(nowMs + 1_000);
  advancedSnapshot.status.ticksReceived = 2;
  advancedSnapshot.status.lastTickEpoch += 1;
  const advanced = evaluateWatchdogSnapshot(advancedSnapshot, first.tracker, nowMs + 1_000, limits);
  assert.equal(advanced.state, "WATCHING");
});

test("watchdog reports collector completion as pending row-level audit", () => {
  const nowMs = Date.parse(until) + 1_000;
  const completed = snapshot(nowMs, { processAlive: false });
  completed.status.state = "COMPLETED";
  const result = evaluateWatchdogSnapshot(completed, tracker(nowMs), nowMs, limits);
  assert.equal(result.state, "COMPLETED");
  assert.match(result.reason, /audit/);
});
