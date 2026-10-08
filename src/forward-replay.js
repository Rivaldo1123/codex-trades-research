import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { symbolDataDirectory } from "./data-store.js";

const PUBLIC_ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const CANDIDATES = Object.freeze([
  { id: "bb20-2-reversal-5t", kind: "bb", durationTicks: 5 },
  { id: "rsi14-reversal-5t", kind: "rsi", durationTicks: 5 },
]);
const DELAYS = Object.freeze([1, 2, 3]);
const WIN_PAYOUTS = Object.freeze([0.7, 0.8, 0.9]);
const STRESS_PAYOUT = 0.8;
const BOOTSTRAP_CONFIDENCE = 0.991667;
const BOOTSTRAP_REPS = 10_000;
const BOOTSTRAP_SEED = 20_261_007;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameNumbers(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function utcEpoch(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error("Forward protocol requires whole-second ISO UTC timestamps.");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms % 1_000 !== 0) {
    throw new Error("Forward protocol requires whole-second ISO UTC timestamps.");
  }
  return ms / 1_000;
}

export function validateForwardProtocol(protocol) {
  if (protocol?.kind !== "preregistered-public-forward-test" ||
      !Number.isSafeInteger(protocol.version) || protocol.version < 1 ||
      protocol.status !== "FROZEN_BEFORE_ELIGIBLE_WINDOW" ||
      protocol.source?.symbol !== "1HZ100V" || protocol.source.endpoint !== PUBLIC_ENDPOINT ||
      protocol.source.authentication !== "none" || protocol.source.orderAccess !== "none" ||
      protocol.safety?.botBuilderRun !== false || protocol.safety.demoOrder !== false ||
      protocol.safety.realOrder !== false || protocol.safety.accountOrTokenUse !== false) {
    throw new Error("Forward protocol safety or public-endpoint lock changed.");
  }
  const fromEpoch = utcEpoch(protocol.eligibleWindow?.fromUtcInclusive);
  const toEpochExclusive = utcEpoch(protocol.eligibleWindow?.toUtcExclusive);
  const frozenEpoch = utcEpoch(protocol.frozenAtUtc);
  if (frozenEpoch >= fromEpoch || toEpochExclusive <= fromEpoch ||
      toEpochExclusive - fromEpoch !== protocol.eligibleWindow.plannedSeconds ||
      toEpochExclusive - fromEpoch > 14 * 86_400 ||
      toEpochExclusive - fromEpoch < 13 * 86_400) {
    throw new Error("Forward protocol has an invalid prospective window.");
  }
  const rules = protocol.candidateRules;
  if (!Array.isArray(rules) || rules.length !== 2 ||
      rules[0].id !== CANDIDATES[0].id || rules[1].id !== CANDIDATES[1].id ||
      rules.some((rule) => rule.durationTicks !== 5) ||
      !rules[0].indicator.includes("population SD") ||
      !rules[0].indicator.includes("most recent 20 ticks including decision tick") ||
      !rules[0].direction.includes("strictly below lower band") ||
      !rules[0].direction.includes("strictly above upper band") ||
      !rules[1].indicator.includes("Wilder smoothing") ||
      !rules[1].indicator.includes("first 14 differences") ||
      !rules[1].direction.includes("strictly below 30") ||
      !rules[1].direction.includes("strictly above 70")) {
    throw new Error("Forward protocol candidate set differs from the fixed two-method design.");
  }
  if (!sameNumbers(protocol.fixedReplayRules?.processingDelayTicks, DELAYS) ||
      !sameNumbers(protocol.fixedReplayRules?.profitPerDollarOnWin, WIN_PAYOUTS) ||
      protocol.fixedReplayRules.profitPerDollarOnLossOrTie !== -1 ||
      !protocol.fixedReplayRules.concurrency.includes("One open") ||
      !protocol.evaluation?.coverage?.includes("99.9%") ||
      !protocol.evaluation?.minimumTrades?.includes("1000") ||
      !protocol.evaluation.minimumTrades.includes("200") ||
      !protocol.evaluation.profitCriterion.includes("99.1667%") ||
      !protocol.evaluation.profitCriterion.includes("10000") ||
      !protocol.evaluation.profitCriterion.includes("20261007")) {
    throw new Error("Forward protocol replay or evaluation rules changed.");
  }
  return { fromEpoch, toEpochExclusive, expectedSeconds: toEpochExclusive - fromEpoch };
}

export function bollingerAt(quotes, index, period = 20, multiplier = 2) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += quotes[i];
  const middle = sum / period;
  let squared = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const delta = quotes[i] - middle;
    squared += delta * delta;
  }
  const sigma = Math.sqrt(squared / period);
  return { middle, upper: middle + multiplier * sigma, lower: middle - multiplier * sigma };
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function rsiAt(quotes, index, period = 14) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = quotes[i] - quotes[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let i = period + 1; i <= index; i += 1) {
    const delta = quotes[i] - quotes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  return rsiFromAverages(averageGain, averageLoss);
}

export function deriveForwardSignals(quotes, present) {
  if (quotes.length !== present.length) throw new Error("Tick presence and price lengths differ.");
  const bb = new Uint8Array(quotes.length);
  const rsi = new Uint8Array(quotes.length);
  let runStart = 0;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 0; index < quotes.length; index += 1) {
    if (!present[index]) {
      runStart = index + 1;
      averageGain = 0;
      averageLoss = 0;
      continue;
    }
    if (index - runStart >= 19) {
      const band = bollingerAt(quotes, index);
      bb[index] = quotes[index] < band.lower ? 1 : quotes[index] > band.upper ? 2 : 0;
    }
    const age = index - runStart;
    if (age === 14) {
      let gains = 0;
      let losses = 0;
      for (let i = runStart + 1; i <= index; i += 1) {
        const delta = quotes[i] - quotes[i - 1];
        gains += Math.max(delta, 0);
        losses += Math.max(-delta, 0);
      }
      averageGain = gains / 14;
      averageLoss = losses / 14;
    } else if (age > 14) {
      const delta = quotes[index] - quotes[index - 1];
      averageGain = (averageGain * 13 + Math.max(delta, 0)) / 14;
      averageLoss = (averageLoss * 13 + Math.max(-delta, 0)) / 14;
    }
    if (age >= 14) {
      const value = rsiFromAverages(averageGain, averageLoss);
      rsi[index] = value < 30 ? 1 : value > 70 ? 2 : 0;
    }
  }
  return { bb, rsi };
}

function emptyCounts() {
  return { evaluatedDecisionTicks: 0, noTradeTicks: 0, skippedForGap: 0,
    settledTrades: 0, wins: 0, losses: 0, ties: 0 };
}

function addCounts(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
}

export function replayForwardHalf({ quotes, present, signals, fromEpoch, startIndex,
  endExclusive, delayTicks, durationTicks = 5, captureTrades = false,
  secondsPerTick = 1 }) {
  if (quotes.length !== present.length || quotes.length !== signals.length ||
      !DELAYS.includes(delayTicks) || durationTicks !== 5 ||
      !Number.isSafeInteger(secondsPerTick) || secondsPerTick < 1 ||
      startIndex < 0 || endExclusive > quotes.length || startIndex >= endExclusive) {
    throw new Error("Invalid forward replay dimensions or fixed timing.");
  }
  const counts = emptyCounts();
  const hourly = new Map();
  const trades = captureTrades ? [] : null;
  let index = startIndex;
  while (index + delayTicks + durationTicks < endExclusive) {
    if (!present[index]) { index += 1; continue; }
    counts.evaluatedDecisionTicks += 1;
    const direction = signals[index];
    if (direction !== 1 && direction !== 2) {
      counts.noTradeTicks += 1;
      index += 1;
      continue;
    }
    const entryIndex = index + delayTicks;
    const settlementIndex = entryIndex + durationTicks;
    let contiguous = true;
    for (let future = index + 1; future <= settlementIndex; future += 1) {
      if (!present[future]) { contiguous = false; break; }
    }
    if (!contiguous) {
      counts.skippedForGap += 1;
      index += 1;
      continue;
    }
    const entry = quotes[entryIndex];
    const exit = quotes[settlementIndex];
    const won = direction === 1 ? exit > entry : exit < entry;
    const tie = exit === entry;
    counts.settledTrades += 1;
    if (won) counts.wins += 1;
    else counts.losses += 1;
    if (tie) counts.ties += 1;
    const hour = Math.floor((fromEpoch + index * secondsPerTick) / 3_600);
    const block = hourly.get(hour) ?? { wins: 0, losses: 0 };
    if (won) block.wins += 1;
    else block.losses += 1;
    hourly.set(hour, block);
    if (trades) {
      trades.push({ signalEpoch: fromEpoch + index * secondsPerTick,
        entryEpoch: fromEpoch + entryIndex * secondsPerTick,
        settlementEpoch: fromEpoch + settlementIndex * secondsPerTick,
        direction: direction === 1 ? "Rise" : "Fall",
        won, tie });
    }
    index = settlementIndex + 1;
  }
  return { counts, hourly, ...(trades ? { trades } : {}) };
}

export function scoreForwardCounts(counts, profitOnWin) {
  const netProfitPerDollarStake = counts.wins * profitOnWin - counts.losses;
  return { ...counts, profitOnWin, profitOnLossOrTie: -1,
    breakEvenWinRate: 1 / (1 + profitOnWin), netProfitPerDollarStake,
    averageProfitPerDollarStake: counts.settledTrades ?
      netProfitPerDollarStake / counts.settledTrades : null,
    winRate: counts.settledTrades ? counts.wins / counts.settledTrades : null };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function hourlyBootstrapLowerBound(hourly, fromEpoch, toEpochExclusive,
  { profitOnWin = STRESS_PAYOUT, confidence = BOOTSTRAP_CONFIDENCE,
    repetitions = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 ||
      confidence <= 0 || confidence >= 1 || toEpochExclusive <= fromEpoch) {
    throw new Error("Invalid fixed hourly bootstrap configuration.");
  }
  const firstHour = Math.floor(fromEpoch / 3_600);
  const lastHour = Math.floor((toEpochExclusive - 1) / 3_600);
  const blocks = [];
  for (let hour = firstHour; hour <= lastHour; hour += 1) {
    blocks.push(hourly.get(hour) ?? { wins: 0, losses: 0 });
  }
  const random = mulberry32(seed);
  const means = new Array(repetitions);
  for (let replication = 0; replication < repetitions; replication += 1) {
    let wins = 0;
    let losses = 0;
    for (let sample = 0; sample < blocks.length; sample += 1) {
      const block = blocks[Math.floor(random() * blocks.length)];
      wins += block.wins;
      losses += block.losses;
    }
    means[replication] = wins + losses ? (wins * profitOnWin - losses) / (wins + losses) : -Infinity;
  }
  means.sort((left, right) => left - right);
  return { lowerBound: means[Math.floor((1 - confidence) * repetitions)],
    confidence, repetitions, seed, block: "UTC clock hour", numberOfBlocks: blocks.length };
}

export function evaluateForwardTicks({ quotes, present, fromEpoch, toEpochExclusive,
  bootstrapRepetitions = BOOTSTRAP_REPS }) {
  if (quotes.length !== toEpochExclusive - fromEpoch || present.length !== quotes.length) {
    throw new Error("Forward replay requires a price/presence slot for every eligible UTC second.");
  }
  const signals = deriveForwardSignals(quotes, present);
  const midpoint = fromEpoch + Math.floor((toEpochExclusive - fromEpoch) / 2);
  const middleIndex = midpoint - fromEpoch;
  const scenarioLedger = [];
  const candidateDecisions = [];
  for (const candidate of CANDIDATES) {
    const failures = [];
    for (const delayTicks of DELAYS) {
      const base = { quotes, present, signals: signals[candidate.kind], fromEpoch,
        delayTicks, durationTicks: 5 };
      const first = replayForwardHalf({ ...base, startIndex: 0, endExclusive: middleIndex });
      const second = replayForwardHalf({ ...base, startIndex: middleIndex,
        endExclusive: quotes.length });
      const fullCounts = addCounts(first.counts, second.counts);
      const hourly = new Map(first.hourly);
      for (const [hour, block] of second.hourly) {
        const previous = hourly.get(hour) ?? { wins: 0, losses: 0 };
        hourly.set(hour, { wins: previous.wins + block.wins,
          losses: previous.losses + block.losses });
      }
      const bound = hourlyBootstrapLowerBound(hourly, fromEpoch, toEpochExclusive,
        { repetitions: bootstrapRepetitions });
      if (fullCounts.settledTrades < 1_000) failures.push("delay=" + delayTicks + ":full:too_few_trades");
      if (first.counts.settledTrades < 200) failures.push("delay=" + delayTicks + ":first:too_few_trades");
      if (second.counts.settledTrades < 200) failures.push("delay=" + delayTicks + ":second:too_few_trades");
      if (scoreForwardCounts(first.counts, STRESS_PAYOUT).averageProfitPerDollarStake <= 0)
        failures.push("delay=" + delayTicks + ":first:nonpositive");
      if (scoreForwardCounts(second.counts, STRESS_PAYOUT).averageProfitPerDollarStake <= 0)
        failures.push("delay=" + delayTicks + ":second:nonpositive");
      if (!(bound.lowerBound > 0)) failures.push("delay=" + delayTicks + ":bootstrap_nonpositive");
      for (const profitOnWin of WIN_PAYOUTS) {
        scenarioLedger.push({ candidateId: candidate.id, delayTicks, profitOnWin,
          firstHalf: scoreForwardCounts(first.counts, profitOnWin),
          secondHalf: scoreForwardCounts(second.counts, profitOnWin),
          fullWindow: scoreForwardCounts(fullCounts, profitOnWin),
          ...(profitOnWin === STRESS_PAYOUT ? { hourlyBootstrap: bound } : {}) });
      }
    }
    candidateDecisions.push({ candidateId: candidate.id, passesForwardResearchGate: !failures.length,
      failures });
  }
  return { splitEpoch: midpoint, model: { candidates: CANDIDATES, delaysTicks: DELAYS,
    profitPerDollarOnWin: WIN_PAYOUTS, profitPerDollarOnLossOrTie: -1,
    tieRule: "loss", oneOpenContract: true, bootstrapConfidence: BOOTSTRAP_CONFIDENCE,
    bootstrapRepetitions, bootstrapSeed: BOOTSTRAP_SEED },
    scenarioLedger, candidateDecisions,
    decision: candidateDecisions.some((item) => item.passesForwardResearchGate) ?
      "READY_FOR_SEPARATE_DEMO_REVIEW" : "NO_TRADE",
    botBuilderRunPermission: false };
}

function missingRangesFromPresence(present, fromEpoch) {
  const ranges = [];
  for (let index = 0; index < present.length;) {
    if (present[index]) { index += 1; continue; }
    const start = index;
    while (index < present.length && !present[index]) index += 1;
    ranges.push({ fromEpoch: fromEpoch + start, toEpochExclusive: fromEpoch + index,
      missingSeconds: index - start });
  }
  return ranges;
}

export async function auditForwardArchive({ projectRoot, symbol, fromEpoch, toEpochExclusive }) {
  const directory = symbolDataDirectory(projectRoot, symbol);
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== 1 || manifest.symbol !== symbol || !Array.isArray(manifest.chunks)) {
    throw new Error("Forward archive manifest format or symbol is invalid.");
  }
  const slots = toEpochExclusive - fromEpoch;
  const quotes = new Float64Array(slots);
  const present = new Uint8Array(slots);
  let observedSeconds = 0;
  let selectedChunks = 0;
  for (const chunk of manifest.chunks) {
    if (chunk.lastEpoch < fromEpoch || chunk.firstEpoch >= toEpochExclusive) continue;
    if (!Number.isSafeInteger(chunk.firstEpoch) || !Number.isSafeInteger(chunk.lastEpoch) ||
        !Number.isSafeInteger(chunk.rows) || chunk.rows < 1 ||
        chunk.firstEpoch > chunk.lastEpoch ||
        !/^[a-f0-9]{64}$/.test(chunk.sha256 ?? "") || typeof chunk.file !== "string") {
      throw new Error("Forward archive chunk metadata is invalid.");
    }
    const chunkPath = path.resolve(directory, chunk.file);
    if (!chunkPath.startsWith(directory + path.sep)) {
      throw new Error("Forward archive chunk path escapes the symbol directory.");
    }
    const compressed = await readFile(chunkPath);
    if (sha256(compressed) !== chunk.sha256) {
      throw new Error("Forward archive checksum failed for " + chunk.file + ".");
    }
    const lines = gunzipSync(compressed).toString("utf8").trimEnd().split("\n");
    if (lines.length !== chunk.rows) throw new Error("Forward archive row count mismatch in " + chunk.file + ".");
    let first = null;
    let last = null;
    for (const line of lines) {
      const tick = JSON.parse(line);
      if (!Number.isSafeInteger(tick.epoch) || !Number.isFinite(tick.quote) ||
          (last !== null && tick.epoch <= last)) {
        throw new Error("Forward archive has an invalid or out-of-order row in " + chunk.file + ".");
      }
      first ??= tick.epoch;
      last = tick.epoch;
      if (tick.epoch < fromEpoch || tick.epoch >= toEpochExclusive) continue;
      const index = tick.epoch - fromEpoch;
      if (present[index]) {
        throw new Error("Forward archive has a duplicate or quote conflict at epoch " + tick.epoch + ".");
      }
      present[index] = 1;
      quotes[index] = tick.quote;
      observedSeconds += 1;
    }
    if (first !== chunk.firstEpoch || last !== chunk.lastEpoch) {
      throw new Error("Forward archive chunk bounds mismatch in " + chunk.file + ".");
    }
    selectedChunks += 1;
  }
  if (sha256(await readFile(manifestPath)) !== sha256(manifestBytes)) {
    throw new Error("Forward archive manifest changed during audit.");
  }
  return { quotes, present, audit: { symbol, fromEpoch, toEpochExclusive,
    expectedSeconds: slots, observedGenuineSeconds: observedSeconds,
    missingSeconds: slots - observedSeconds, coverage: observedSeconds / slots,
    missingRanges: missingRangesFromPresence(present, fromEpoch), selectedChunks,
    manifestSha256: sha256(manifestBytes),
    checks: "Selected chunk SHA-256, row counts, bounds, ordering, duplicate/conflict rejection, and every eligible UTC second verified." } };
}

export function verifyPlatformParity(proof, protocolSha256) {
  if (proof?.kind !== "deriv-bot-builder-platform-parity" ||
      proof.protocolSha256 !== protocolSha256 || proof.verified !== true ||
      proof.tickTimingVerified !== true ||
      typeof proof.evidence !== "string" || !proof.evidence.trim() ||
      !Array.isArray(proof.bbVectors) || proof.bbVectors.length < 2 ||
      !Array.isArray(proof.rsiVectors) || proof.rsiVectors.length < 2) {
    throw new Error("Bot Builder indicator/tick-timing parity has not been verified.");
  }
  for (const vector of proof.bbVectors) {
    if (!Array.isArray(vector.quotes) || vector.quotes.length !== 20 ||
        vector.quotes.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(vector.lower) || !Number.isFinite(vector.upper)) {
      throw new Error("Bot Builder BB parity vector is invalid.");
    }
    const actual = bollingerAt(vector.quotes, 19);
    if (Math.abs(actual.lower - vector.lower) > 1e-8 ||
        Math.abs(actual.upper - vector.upper) > 1e-8) {
      throw new Error("Bot Builder BB calculation differs from the frozen replay.");
    }
  }
  for (const vector of proof.rsiVectors) {
    if (!Array.isArray(vector.quotes) || vector.quotes.length < 15 ||
        vector.quotes.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(vector.rsi)) {
      throw new Error("Bot Builder RSI parity vector is invalid.");
    }
    const actual = rsiAt(vector.quotes, vector.quotes.length - 1);
    if (Math.abs(actual - vector.rsi) > 1e-8) {
      throw new Error("Bot Builder RSI calculation differs from the frozen replay.");
    }
  }
  return { verified: true, evidence: proof.evidence, verifiedAtUtc: proof.verifiedAtUtc ?? null };
}

export function validateCompletedForwardCollectorStatus(status, protocol) {
  const actualEnd = Date.parse(status?.endsAt);
  const expectedEnd = Date.parse(protocol.eligibleWindow.toUtcExclusive);
  if (status?.state !== "COMPLETED" || status.mode !== "public-data-only" ||
      status.collectionMode !== "forward-only" ||
      status.finalization?.requested !== false ||
      status.symbol !== protocol.source.symbol || status.endpoint !== PUBLIC_ENDPOINT ||
      !Number.isFinite(actualEnd) || actualEnd !== expectedEnd) {
    throw new Error("Forward public collector did not complete the frozen endpoint/symbol/window.");
  }
  return { state: status.state, collectionMode: status.collectionMode,
    startedAt: status.startedAt, endsAt: status.endsAt, updatedAt: status.updatedAt };
}

async function collectorCompleted(projectRoot, protocol) {
  const marketDirectory = path.join(projectRoot, "data", "market");
  try {
    await readFile(path.join(marketDirectory, "collector.lock"));
    throw new Error("Forward collector lock is still present; await final audit and shutdown.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const status = JSON.parse(await readFile(path.join(marketDirectory, "live-collector-status.json"), "utf8"));
  return validateCompletedForwardCollectorStatus(status, protocol);
}

export function assertForwardWindowClosed(toEpochExclusive, nowMs) {
  if (!Number.isSafeInteger(toEpochExclusive) || !Number.isFinite(nowMs) ||
      nowMs < toEpochExclusive * 1_000) {
    throw new Error("Forward window has not closed; performance inspection is forbidden.");
  }
}

export async function runForwardReplay({ projectRoot, protocolPath, expectedProtocolSha256,
  parityPath = path.join(projectRoot, "data", "market", "forward-platform-parity.json") }) {
  if (!/^[a-f0-9]{64}$/.test(expectedProtocolSha256 ?? "")) {
    throw new Error("A precommitted 64-hex protocol SHA-256 is required.");
  }
  const protocolBytes = await readFile(protocolPath);
  const protocolSha256 = sha256(protocolBytes);
  if (protocolSha256 !== expectedProtocolSha256) {
    throw new Error("Frozen forward protocol checksum changed.");
  }
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  const { fromEpoch, toEpochExclusive } = validateForwardProtocol(protocol);
  const nowMs = Date.now();
  assertForwardWindowClosed(toEpochExclusive, nowMs);
  const collector = await collectorCompleted(projectRoot, protocol);
  const { quotes, present, audit } = await auditForwardArchive({ projectRoot,
    symbol: protocol.source.symbol, fromEpoch, toEpochExclusive });
  const report = { kind: "preregistered-public-forward-replay", mode: "research-only",
    generatedAt: new Date(nowMs).toISOString(), protocolPath, protocolSha256,
    window: { fromUtcInclusive: protocol.eligibleWindow.fromUtcInclusive,
      toUtcExclusive: protocol.eligibleWindow.toUtcExclusive, symbol: protocol.source.symbol },
    collector, audit, botBuilderRunPermission: false,
    limitations: ["Public ticks are not executable contract quotes.",
      "Entry delay and payouts are fixed sensitivity scenarios, not measured fills.",
      "No account, token, Bot Builder Run, Demo order, or real order is used."] };
  if (audit.coverage < 0.999) {
    report.decision = "INCONCLUSIVE";
    report.reason = "Genuine-second coverage below frozen 99.9% threshold.";
  } else {
    let proof;
    try {
      proof = JSON.parse(await readFile(parityPath, "utf8"));
      report.platformParity = verifyPlatformParity(proof, protocolSha256);
    } catch (error) {
      report.decision = "INCONCLUSIVE";
      report.reason = "Bot Builder calculation/tick-timing parity unverified: " + error.message;
    }
    if (report.platformParity?.verified) {
      const evaluation = evaluateForwardTicks({ quotes, present, fromEpoch,
        toEpochExclusive });
      Object.assign(report, evaluation);
    }
  }
  const reportsDirectory = path.join(projectRoot, "data", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = path.join(reportsDirectory,
    "forward-replay-" + protocol.source.symbol + "-" + fromEpoch + "-" + toEpochExclusive +
    "-" + Date.now() + ".json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return { report, reportPath };
}
