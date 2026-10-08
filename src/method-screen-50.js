import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";
import { auditForwardArchive, replayForwardHalf, scoreForwardCounts } from "./forward-replay.js";
import { buildTwentyMethodSignals } from "./method-screen-20.js";
import { overlayVerifiedHistory } from "./retrospective-pilot-replay.js";

const CATALOG_SHA256 = "fb63246f03ea7060821b442e7e687ab584964261c0c2e50993b01478e8370a02";
const PRIOR_REPORT = "method-screen-20-1HZ100V-1788667200-1791259200.json";
const RECOVERY_REPORT = "retrospective-pilot-recovery-1HZ100V-1791392400-1791417600.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function directionOf(delta) {
  return delta > 0 ? 1 : delta < 0 ? 2 : 0;
}

function reverse(direction) {
  return direction === 1 ? 2 : direction === 2 ? 1 : 0;
}

export function newMethodIds() {
  const ids = [];
  for (const lag of [2, 3, 5, 10, 20, 30]) {
    for (const mode of ["trend", "reverse"]) ids.push(`tick-momentum-${lag}-${mode}`);
  }
  for (const length of [2, 3, 4]) {
    for (const mode of ["trend", "reverse"]) ids.push(`tick-streak-${length}-${mode}`);
  }
  for (const window of [10, 20, 50]) {
    for (const mode of ["trend", "reverse"]) ids.push(`price-sma-${window}-${mode}`);
  }
  for (const multiplier of [1.5, 2, 3]) {
    for (const mode of ["trend", "reverse"]) ids.push(`tick-impulse-20-${multiplier}-${mode}`);
  }
  return ids;
}

export function buildThirtyNewMethodSignals(quotes, present, boundaries = []) {
  if (quotes.length !== present.length || boundaries.some((index) =>
    !Number.isSafeInteger(index) || index <= 0 || index >= quotes.length)) {
    throw new Error("New-method quote, presence or split dimensions are invalid.");
  }
  const ids = newMethodIds();
  if (ids.length !== 30 || new Set(ids).size !== 30) throw new Error("New-method grid is not exactly 30.");
  const signals = Object.fromEntries(ids.map((id) => [id, new Uint8Array(quotes.length)]));
  const resetAt = new Set(boundaries);
  let runStart = 0;
  let previous = NaN;
  let upStreak = 0, downStreak = 0;
  let sum10 = 0, sum20 = 0, sum50 = 0, absoluteChangeSum20 = 0;
  for (let i = 0; i < quotes.length; i += 1) {
    if (!present[i] || resetAt.has(i)) {
      runStart = i;
      previous = NaN;
      upStreak = downStreak = 0;
      sum10 = sum20 = sum50 = absoluteChangeSum20 = 0;
      if (!present[i]) { runStart = i + 1; continue; }
    }
    const quote = quotes[i];
    if (!Number.isFinite(quote)) throw new Error(`Invalid quote at index ${i}.`);
    const n = i - runStart + 1;
    const change = n > 1 ? quote - previous : 0;
    upStreak = change > 0 ? upStreak + 1 : 0;
    downStreak = change < 0 ? downStreak + 1 : 0;
    sum10 += quote; if (n > 10) sum10 -= quotes[i - 10];
    sum20 += quote; if (n > 20) sum20 -= quotes[i - 20];
    sum50 += quote; if (n > 50) sum50 -= quotes[i - 50];
    if (n > 1) absoluteChangeSum20 += Math.abs(change);
    if (n > 21) absoluteChangeSum20 -= Math.abs(quotes[i - 20] - quotes[i - 21]);

    for (const lag of [2, 3, 5, 10, 20, 30]) {
      const direction = n > lag ? directionOf(quote - quotes[i - lag]) : 0;
      signals[`tick-momentum-${lag}-trend`][i] = direction;
      signals[`tick-momentum-${lag}-reverse`][i] = reverse(direction);
    }
    for (const length of [2, 3, 4]) {
      const direction = upStreak >= length ? 1 : downStreak >= length ? 2 : 0;
      signals[`tick-streak-${length}-trend`][i] = direction;
      signals[`tick-streak-${length}-reverse`][i] = reverse(direction);
    }
    for (const [window, sum] of [[10, sum10], [20, sum20], [50, sum50]]) {
      const direction = n >= window ? directionOf(quote - sum / window) : 0;
      signals[`price-sma-${window}-trend`][i] = direction;
      signals[`price-sma-${window}-reverse`][i] = reverse(direction);
    }
    const meanAbsoluteChange = n >= 21 ? absoluteChangeSum20 / 20 : NaN;
    for (const multiplier of [1.5, 2, 3]) {
      const direction = meanAbsoluteChange > 0 && Math.abs(change) > multiplier * meanAbsoluteChange ?
        directionOf(change) : 0;
      signals[`tick-impulse-20-${multiplier}-trend`][i] = direction;
      signals[`tick-impulse-20-${multiplier}-reverse`][i] = reverse(direction);
    }
    previous = quote;
  }
  return signals;
}

function evaluateMethods({ quotes, present, signals, fromEpoch, cuts, payouts, delays }) {
  const ledger = [];
  const edges = [0, ...cuts, quotes.length];
  for (const [methodId, methodSignals] of Object.entries(signals)) {
    for (const delayTicks of delays) {
      const counts = [];
      for (let segment = 0; segment < edges.length - 1; segment += 1) {
        counts.push(replayForwardHalf({ quotes, present, signals: methodSignals, fromEpoch,
          startIndex: edges[segment], endExclusive: edges[segment + 1],
          delayTicks, durationTicks: 5 }).counts);
      }
      for (const profitOnWin of payouts) {
        ledger.push({ methodId, delayTicks, profitOnWin,
          segments: counts.map((item) => scoreForwardCounts(item, profitOnWin)) });
      }
    }
  }
  return ledger;
}

function validatePriorLedger(prior, catalog, manifestSha256) {
  const expectedIds = Object.keys(buildTwentyMethodSignals(new Float64Array(1), new Uint8Array(1)));
  const keys = new Set();
  if (prior.kind !== "exploratory-twenty-method-screen" ||
      prior.catalogSha256 !== catalog.priorTwenty.catalogSha256 ||
      prior.audit.manifestSha256 !== manifestSha256 ||
      prior.audit.observedGenuineSeconds !== 2_591_993 ||
      prior.scenarioLedger.length !== 180 || expectedIds.length !== 20 ||
      prior.methodDefinitions.some((item, index) => item.id !== expectedIds[index])) {
    throw new Error("Prior 20-method report does not match its fixed archive or definitions.");
  }
  for (const row of prior.scenarioLedger) {
    const key = `${row.methodId}/${row.delayTicks}/${row.profitOnWin}`;
    if (!expectedIds.includes(row.methodId) || ![1, 2, 3].includes(row.delayTicks) ||
        ![0.7, 0.8, 0.9].includes(row.profitOnWin) || keys.has(key) ||
        !row.early || !row.middle || !row.late) {
      throw new Error("Prior 20-method scenario ledger is incomplete or changed.");
    }
    keys.add(key);
  }
  return expectedIds;
}

export function rankFiftyMethods(ledger, ids, floors = [250, 250, 50, 50]) {
  if (ids.length !== 50 || new Set(ids).size !== 50 || ledger.length !== 450 ||
      floors.length !== 4) throw new Error("Fifty-method ranking dimensions are invalid.");
  const ranking = ids.map((methodId) => {
    const primary = ledger.filter((row) => row.methodId === methodId && row.profitOnWin === 0.8);
    const stress = ledger.filter((row) => row.methodId === methodId && row.profitOnWin === 0.7);
    if (primary.length !== 3 || stress.length !== 3 ||
        [...primary, ...stress].some((row) => ![1, 2, 3].includes(row.delayTicks) ||
          row.segments.length !== 4)) throw new Error(`Incomplete four-segment ledger: ${methodId}.`);
    const tradeFloorMet = floors.every((floor, segment) =>
      primary.every((row) => row.segments[segment].settledTrades >= floor));
    const worstPrimaryReturn = Math.min(...primary.flatMap((row) =>
      row.segments.map((segment) => segment.averageProfitPerDollarStake ?? -Infinity)));
    const worstLateStressReturn = Math.min(...stress.flatMap((row) =>
      [row.segments[1], row.segments[3]].map((segment) =>
        segment.averageProfitPerDollarStake ?? -Infinity)));
    return { methodId, tradeFloorMet, worstPrimaryReturn, worstLateStressReturn,
      minimumTradesBySegment: floors.map((_, index) => Math.min(...primary.map((row) =>
        row.segments[index].settledTrades))),
      passesDevelopmentScreen: tradeFloorMet && worstPrimaryReturn > 0 &&
        worstLateStressReturn > 0 };
  });
  ranking.sort((a, b) => Number(b.tradeFloorMet) - Number(a.tradeFloorMet) ||
    b.worstPrimaryReturn - a.worstPrimaryReturn || a.methodId.localeCompare(b.methodId));
  return { ranking: ranking.map((item, index) => ({ rank: index + 1, ...item })),
    provisionalTopThree: ranking.slice(0, 3).map((item) => item.methodId),
    developmentPassCount: ranking.filter((item) => item.passesDevelopmentScreen).length };
}

export async function runFiftyMethodScreen({ projectRoot }) {
  const catalogBytes = await readFile(path.join(projectRoot, "data", "market", "method-screen-50-v1.json"));
  if (sha256(catalogBytes) !== CATALOG_SHA256) throw new Error("Frozen 50-method catalog checksum changed.");
  const catalog = JSON.parse(catalogBytes);
  if (catalog.kind !== "bounded-bot-builder-method-screen-50" || catalog.symbol !== "1HZ100V" ||
      catalog.endpoint !== PUBLIC_ENDPOINT || catalog.newMethodGrid.length !== 4 ||
      catalog.timing.durationTicks !== 5 || catalog.timing.oneOpenContract !== true ||
      JSON.stringify(catalog.timing.processingDelayTicks) !== "[1,2,3]" ||
      JSON.stringify(catalog.payout.profitPerDollarOnWin) !== "[0.7,0.8,0.9]" ||
      catalog.botBuilderRunPermission !== false || catalog.demoOrderPermission !== false ||
      catalog.realOrderPermission !== false) throw new Error("Fifty-method safety catalog changed.");
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== catalog.symbol) throw new Error("Public-only data safety lock changed.");
  const reportDirectory = path.join(projectRoot, "data", "reports");
  const priorBytes = await readFile(path.join(reportDirectory, PRIOR_REPORT));
  if (sha256(priorBytes) !== catalog.priorTwenty.reportSha256) {
    throw new Error("Prior 20-method report checksum changed.");
  }
  const prior = JSON.parse(priorBytes);
  const thirty = catalog.developmentSeries[0];
  const archive = await auditForwardArchive({ projectRoot, symbol: catalog.symbol,
    fromEpoch: thirty.fromEpoch, toEpochExclusive: thirty.toEpochExclusive });
  if (archive.audit.expectedSeconds !== thirty.expectedSeconds ||
      archive.audit.observedGenuineSeconds !== thirty.genuineSeconds ||
      archive.audit.missingSeconds !== thirty.missingSeconds) {
    throw new Error("Thirty-day archive integrity or known seven-second gap changed.");
  }
  const priorIds = validatePriorLedger(prior, catalog, archive.audit.manifestSha256);
  const archiveCuts = [Math.floor(archive.quotes.length * 0.7), Math.floor(archive.quotes.length * 0.85)];
  const newIds = newMethodIds();
  const newArchiveSignals = buildThirtyNewMethodSignals(archive.quotes, archive.present, archiveCuts);
  const newArchiveLedger = evaluateMethods({ ...archive, signals: newArchiveSignals,
    fromEpoch: thirty.fromEpoch, cuts: archiveCuts,
    payouts: catalog.payout.profitPerDollarOnWin,
    delays: catalog.timing.processingDelayTicks });
  const recoveryBytes = await readFile(path.join(reportDirectory, RECOVERY_REPORT));
  const pilot = catalog.developmentSeries[1];
  if (sha256(recoveryBytes) !== pilot.recoveryReportSha256) {
    throw new Error("Retrospective pilot recovery checksum changed.");
  }
  const recovery = JSON.parse(recoveryBytes);
  if (recovery.state !== "RECOVERED_SEPARATELY" || recovery.symbol !== catalog.symbol ||
      recovery.endpoint !== PUBLIC_ENDPOINT || recovery.fromEpoch !== pilot.fromEpoch ||
      recovery.toEpochExclusive !== pilot.toEpochExclusive ||
      recovery.recoveredRows !== pilot.historicalSecondsAdded || recovery.stillMissingRows !== 0) {
    throw new Error("Retrospective pilot recovery provenance changed.");
  }
  const recovered = recovery.ranges.flatMap((range) => range.recovered);
  if (sha256(Buffer.from(JSON.stringify(recovered))) !== recovery.recoveredTicksSha256) {
    throw new Error("Recovered public tick checksum changed.");
  }
  const originalPilot = await auditForwardArchive({ projectRoot, symbol: catalog.symbol,
    fromEpoch: pilot.fromEpoch, toEpochExclusive: pilot.toEpochExclusive });
  if (originalPilot.audit.manifestSha256 !== recovery.liveManifestSha256 ||
      originalPilot.audit.observedGenuineSeconds !== pilot.originalLiveSeconds ||
      originalPilot.audit.missingSeconds !== pilot.historicalSecondsAdded) {
    throw new Error("Original live-pilot archive changed.");
  }
  const composite = overlayVerifiedHistory(originalPilot.quotes, originalPilot.present,
    recovered, pilot.fromEpoch);
  if (composite.added !== pilot.historicalSecondsAdded ||
      composite.present.some((item) => item !== 1)) {
    throw new Error("Retrospective composite did not cover the exact pilot window.");
  }
  const pilotCut = Math.floor(composite.quotes.length / 2);
  const pilotSignals = { ...buildTwentyMethodSignals(composite.quotes, composite.present, [pilotCut]),
    ...buildThirtyNewMethodSignals(composite.quotes, composite.present, [pilotCut]) };
  if (Object.keys(pilotSignals).length !== 50) throw new Error("Pilot method set is not exactly 50.");
  const pilotLedger = evaluateMethods({ ...composite, signals: pilotSignals,
    fromEpoch: pilot.fromEpoch, cuts: [pilotCut],
    payouts: catalog.payout.profitPerDollarOnWin,
    delays: catalog.timing.processingDelayTicks });
  const priorRows = prior.scenarioLedger.map((row) => ({ methodId: row.methodId,
    delayTicks: row.delayTicks, profitOnWin: row.profitOnWin,
    segments: [row.early, row.middle, row.late] }));
  const pilotByKey = new Map(pilotLedger.map((row) =>
    [`${row.methodId}/${row.delayTicks}/${row.profitOnWin}`, row]));
  const ledger = [...priorRows, ...newArchiveLedger].map((row) => {
    const key = `${row.methodId}/${row.delayTicks}/${row.profitOnWin}`;
    const matchingPilot = pilotByKey.get(key);
    if (!matchingPilot) throw new Error(`Pilot scenario missing: ${key}.`);
    pilotByKey.delete(key);
    return { methodId: row.methodId, delayTicks: row.delayTicks,
      profitOnWin: row.profitOnWin,
      segments: [row.segments[1], row.segments[2], ...matchingPilot.segments] };
  });
  if (ledger.length !== 450 || pilotByKey.size !== 0 || priorIds.length + newIds.length !== 50) {
    throw new Error("Complete 50-method scenario ledger was not produced.");
  }
  const ranked = rankFiftyMethods(ledger, [...priorIds, ...newIds]);
  const report = { kind: "exploratory-fifty-method-screen", generatedAtUtc: new Date().toISOString(),
    catalogSha256: CATALOG_SHA256, symbol: catalog.symbol, endpoint: PUBLIC_ENDPOINT,
    methodCount: 50, scenarioCount: 450,
    methodIds: [...priorIds, ...newIds], priorTwentyReportSha256: sha256(priorBytes),
    recoveryReportSha256: sha256(recoveryBytes),
    data: { thirtyDay: archive.audit, pilotOriginal: originalPilot.audit,
      pilotRetrospectiveRowsAdded: composite.added, pilotCombinedRows: composite.quotes.length },
    segmentWindows: [
      [thirty.fromEpoch + archiveCuts[0], thirty.fromEpoch + archiveCuts[1]],
      [thirty.fromEpoch + archiveCuts[1], thirty.toEpochExclusive],
      [pilot.fromEpoch, pilot.fromEpoch + pilotCut],
      [pilot.fromEpoch + pilotCut, pilot.toEpochExclusive],
    ],
    segmentNames: ["thirtyDayMiddle", "thirtyDayLate", "pilotFirst", "pilotSecond"],
    scenarioLedger: ledger, ...ranked,
    decision: ranked.developmentPassCount ? "DEVELOPMENT_SIGNAL_REQUIRES_NEW_UNTOUCHED_TEST" :
      "NO_TRADE_NO_DEVELOPMENT_PASS",
    evidenceLevel: "ADAPTIVE_RETROSPECTIVE_DEVELOPMENT_ONLY",
    observedExecutablePayouts: false, botBuilderParity: "UNVERIFIED",
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
    limitations: catalog.knownLimitations };
  const reportPath = path.join(reportDirectory,
    `method-screen-50-${catalog.symbol}-${thirty.fromEpoch}-${pilot.toEpochExclusive}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
