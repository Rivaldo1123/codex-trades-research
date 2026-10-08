import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditForwardArchive, deriveForwardSignals, replayForwardHalf,
  scoreForwardCounts, validateCompletedForwardCollectorStatus } from "./forward-replay.js";

const PUBLIC_ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const CANDIDATES = Object.freeze([
  { id: "bb20-2-reversal-5t", signal: "bb" },
  { id: "rsi14-reversal-5t", signal: "rsi" },
]);
const DELAYS = Object.freeze([1, 2, 3]);
const PAYOUTS = Object.freeze([0.7, 0.8, 0.9]);
const MINIMUM_COVERAGE = 0.999;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utcEpoch(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error("Pilot protocol requires whole-second ISO UTC timestamps.");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value.replace("Z", ".000Z")) {
    throw new Error("Pilot protocol contains an invalid UTC timestamp.");
  }
  return millis / 1_000;
}

function sameNumbers(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

export function validatePilotProtocol(protocol) {
  if (protocol?.kind !== "preregistered-public-short-pilot" ||
      protocol.version !== 3 ||
      protocol.status !== "FROZEN_BEFORE_ELIGIBLE_WINDOW" ||
      protocol.source?.symbol !== "1HZ100V" ||
      protocol.source.endpoint !== PUBLIC_ENDPOINT ||
      protocol.source.authentication !== "none" ||
      protocol.source.orderAccess !== "none" ||
      protocol.safety?.botBuilderRun !== false ||
      protocol.safety.demoOrder !== false ||
      protocol.safety.realOrder !== false ||
      protocol.safety.accountOrTokenUse !== false) {
    throw new Error("Pilot protocol public-only safety lock changed.");
  }
  const fromEpoch = utcEpoch(protocol.eligibleWindow?.fromUtcInclusive);
  const toEpochExclusive = utcEpoch(protocol.eligibleWindow?.toUtcExclusive);
  const frozenEpoch = utcEpoch(protocol.frozenAtUtc);
  if (fromEpoch !== Date.parse("2026-10-07T17:00:00Z") / 1_000 ||
      toEpochExclusive !== Date.parse("2026-10-08T00:00:00Z") / 1_000 ||
      frozenEpoch >= fromEpoch ||
      protocol.eligibleWindow.plannedSeconds !== toEpochExclusive - fromEpoch ||
      toEpochExclusive - fromEpoch !== 25_200) {
    throw new Error("Pilot protocol exact prospective window changed.");
  }
  const rules = protocol.candidateRules;
  if (!Array.isArray(rules) || rules.length !== CANDIDATES.length ||
      rules.some((rule, index) => rule.id !== CANDIDATES[index].id ||
        rule.durationTicks !== 5) ||
      !rules[0].indicator.includes("population SD") ||
      !rules[0].indicator.includes("most recent 20 ticks including decision tick") ||
      !rules[0].direction.includes("strictly below lower band") ||
      !rules[0].direction.includes("strictly above upper band") ||
      !rules[1].indicator.includes("Wilder smoothing") ||
      !rules[1].indicator.includes("first 14 differences") ||
      !rules[1].direction.includes("strictly below 30") ||
      !rules[1].direction.includes("strictly above 70") ||
      !sameNumbers(protocol.fixedReplayRules?.processingDelayTicks, DELAYS) ||
      !sameNumbers(protocol.fixedReplayRules?.profitPerDollarOnWin, PAYOUTS) ||
      protocol.fixedReplayRules.profitPerDollarOnLossOrTie !== -1 ||
      !protocol.fixedReplayRules.entryAndExpiry.includes("At most one open") ||
      !protocol.evaluation?.outcome?.includes("DEVELOPMENT_ONLY or INCONCLUSIVE")) {
    throw new Error("Pilot protocol fixed candidate or evaluation rules changed.");
  }
  return { fromEpoch, toEpochExclusive, expectedSeconds: toEpochExclusive - fromEpoch };
}

export function assertPilotWindowClosed(toEpochExclusive, nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < toEpochExclusive * 1_000) {
    throw new Error("Pilot window has not closed; performance inspection is forbidden.");
  }
}

function addCounts(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
}

export function evaluatePilotTicks({ quotes, present, fromEpoch, toEpochExclusive }) {
  if (quotes.length !== toEpochExclusive - fromEpoch || present.length !== quotes.length) {
    throw new Error("Pilot replay requires one price/presence slot per eligible UTC second.");
  }
  const midpointIndex = Math.floor(quotes.length / 2);
  const signals = deriveForwardSignals(quotes, present);
  const secondHalfSignals = deriveForwardSignals(quotes.subarray(midpointIndex),
    present.subarray(midpointIndex));
  signals.bb.set(secondHalfSignals.bb, midpointIndex);
  signals.rsi.set(secondHalfSignals.rsi, midpointIndex);
  const scenarioLedger = [];
  for (const candidate of CANDIDATES) {
    for (const delayTicks of DELAYS) {
      const base = { quotes, present, signals: signals[candidate.signal], fromEpoch,
        delayTicks, durationTicks: 5 };
      const first = replayForwardHalf({ ...base, startIndex: 0,
        endExclusive: midpointIndex });
      const second = replayForwardHalf({ ...base, startIndex: midpointIndex,
        endExclusive: quotes.length });
      const fullCounts = addCounts(first.counts, second.counts);
      for (const profitOnWin of PAYOUTS) {
        scenarioLedger.push({ candidateId: candidate.id, delayTicks, profitOnWin,
          firstHalf: scoreForwardCounts(first.counts, profitOnWin),
          secondHalf: scoreForwardCounts(second.counts, profitOnWin),
          fullWindow: scoreForwardCounts(fullCounts, profitOnWin) });
      }
    }
  }
  return { splitEpoch: fromEpoch + midpointIndex,
    model: { candidates: CANDIDATES, processingDelayTicks: DELAYS,
      profitPerDollarOnWin: PAYOUTS, profitPerDollarOnLossOrTie: -1,
      tieRule: "loss", oneOpenHypotheticalContract: true,
      gaps: "Never bridge a missing second; indicator state resets after a gap.",
      chronologicalHalves: "Lookback, decision, entry and expiry stay within each half." },
    scenarioLedger };
}

async function completedPilotCollector(projectRoot, protocol) {
  const marketDirectory = path.join(projectRoot, "data", "market");
  try {
    await readFile(path.join(marketDirectory, "collector.lock"));
    throw new Error("Public collector lock remains; await collector shutdown.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== protocol.source.symbol) {
    throw new Error("Public collector configuration safety lock changed.");
  }
  const status = JSON.parse(await readFile(path.join(marketDirectory,
    "live-collector-status.json"), "utf8"));
  const result = validateCompletedForwardCollectorStatus(status, protocol);
  if (!Number.isFinite(Date.parse(status.startedAt)) ||
      Date.parse(status.startedAt) > Date.parse(protocol.eligibleWindow.fromUtcInclusive) ||
      !Number.isFinite(Date.parse(status.updatedAt)) ||
      Date.parse(status.updatedAt) < Date.parse(protocol.eligibleWindow.toUtcExclusive)) {
    throw new Error("Public collector did not span the complete pilot window.");
  }
  return { ...result, pid: status.pid, ticksReceived: status.ticksReceived,
    ticksStored: status.ticksStored, chunksStored: status.chunksStored };
}

export async function runPilotReplay({ projectRoot, protocolPath, expectedProtocolSha256,
  nowMs = Date.now() }) {
  if (!/^[a-f0-9]{64}$/.test(expectedProtocolSha256 ?? "")) {
    throw new Error("A precommitted 64-hex pilot protocol SHA-256 is required.");
  }
  const protocolBytes = await readFile(protocolPath);
  const protocolSha256 = sha256(protocolBytes);
  if (protocolSha256 !== expectedProtocolSha256) {
    throw new Error("Frozen pilot protocol checksum changed.");
  }
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  const { fromEpoch, toEpochExclusive } = validatePilotProtocol(protocol);
  assertPilotWindowClosed(toEpochExclusive, nowMs);
  const collector = await completedPilotCollector(projectRoot, protocol);
  const { quotes, present, audit } = await auditForwardArchive({ projectRoot,
    symbol: protocol.source.symbol, fromEpoch, toEpochExclusive });
  const report = { kind: "public-short-pilot-replay", mode: "research-only",
    decision: "INCONCLUSIVE", botBuilderRunPermission: false,
    demoOrderPermission: false, realOrderPermission: false,
    generatedAtUtc: new Date(nowMs).toISOString(), protocolPath, protocolSha256,
    window: { fromUtcInclusive: protocol.eligibleWindow.fromUtcInclusive,
      toUtcExclusive: protocol.eligibleWindow.toUtcExclusive,
      symbol: protocol.source.symbol }, collector, audit,
    minimumCoverage: MINIMUM_COVERAGE,
    limitations: [
      "Seven hours cannot satisfy the original approximately 14-day forward validation gate.",
      "Deriv Bot Bollinger/RSI indicator and tick-timing parity are unverified.",
      "Public ticks are not executable contract quotes; delay and payout values are assumptions, not fills.",
      "No account, token, Bot Builder Run, Demo order or real order is used.",
      "A positive exploratory sample is not evidence of dependable profit or permission to trade.",
    ] };
  if (audit.coverage < MINIMUM_COVERAGE) {
    report.reason = "Genuine-second coverage below the frozen 99.9% descriptive-replay threshold.";
    report.scenarioLedger = [];
  } else {
    Object.assign(report, evaluatePilotTicks({ quotes, present, fromEpoch, toEpochExclusive }));
    report.decision = "DEVELOPMENT_ONLY";
    report.reason = "All fixed exploratory scenarios are descriptive; no validation or trading gate exists for this short pilot.";
  }
  const reportPath = path.join(projectRoot, "data", "reports",
    `pilot-replay-${protocol.source.symbol}-${fromEpoch}-${toEpochExclusive}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return { report, reportPath };
}
