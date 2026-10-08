import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";
import { auditForwardArchive, replayForwardHalf, scoreForwardCounts } from "./forward-replay.js";
import { overlayVerifiedHistory } from "./retrospective-pilot-replay.js";

const CATALOG_SHA256 = "9f45a2b73a4880edac58f9f89e565b01f81819dbd533378285752c177ec9d24a";
const PRIOR_REPORT = "method-screen-50-1HZ100V-1788667200-1791417600.json";
const PRIOR_CATALOG = "method-screen-50-v1.json";
const RECOVERY_REPORT = "retrospective-pilot-recovery-1HZ100V-1791392400-1791417600.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseValues(family) {
  switch (family.name) {
    case "normalized-lag-momentum": return family.lags;
    case "normalized-price-sma-distance": return family.windows;
    case "normalized-tick-streak": return family.lengths;
    case "normalized-sma-spread": return family.fastSlowPairs;
    case "relative-tick-impulse": return family.meanAbsoluteChangeWindows;
    default: throw new Error(`Unknown additional-method family: ${family.name}`);
  }
}

function baseLabel(base) {
  return Array.isArray(base) ? base.join("-") : String(base);
}

export function additionalMethodGroups(catalog) {
  if (!Array.isArray(catalog.families) || catalog.families.length !== 5) {
    throw new Error("Additional-method catalog needs exactly five families.");
  }
  const groups = [];
  for (const family of catalog.families) {
    const bases = baseValues(family);
    if (bases.length !== 10 || family.thresholds.length !== 5 ||
        JSON.stringify(family.modes) !== '["trend","reverse"]' ||
        family.thresholds.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`Invalid 100-variant grid: ${family.name}.`);
    }
    for (const base of bases) {
      const ids = family.thresholds.flatMap((threshold) => family.modes.map((mode) =>
        `${family.name}-${baseLabel(base)}-${threshold}-${mode}`));
      groups.push({ family, base, ids });
    }
  }
  const ids = groups.flatMap((group) => group.ids);
  if (groups.length !== 50 || ids.length !== 500 || new Set(ids).size !== 500) {
    throw new Error("Additional-method grid is not 500 unique variants.");
  }
  return groups;
}

function signDirection(delta) {
  return delta > 0 ? 1 : delta < 0 ? 2 : 0;
}

export function buildVariantGroupSignals(quotes, present, boundaries, group) {
  if (quotes.length !== present.length || group.ids.length !== 10 ||
      boundaries.some((index) => !Number.isSafeInteger(index) || index <= 0 ||
        index >= quotes.length)) {
    throw new Error("Additional-method quote, presence or split dimensions are invalid.");
  }
  const { family, base } = group;
  const signals = Object.fromEntries(group.ids.map((id) => [id, new Uint8Array(quotes.length)]));
  const rows = group.ids.map((id) => signals[id]);
  const resetAt = new Set(boundaries);
  const name = family.name;
  const absoluteWindow = name === "relative-tick-impulse" ? base : 20;
  let runStart = 0, previous = NaN, upStreak = 0, downStreak = 0;
  let absoluteSum = 0, firstSum = 0, secondSum = 0;
  for (let i = 0; i < quotes.length; i += 1) {
    if (!present[i] || resetAt.has(i)) {
      runStart = i;
      previous = NaN;
      upStreak = downStreak = 0;
      absoluteSum = firstSum = secondSum = 0;
      if (!present[i]) { runStart = i + 1; continue; }
    }
    const quote = quotes[i];
    if (!Number.isFinite(quote)) throw new Error(`Invalid quote at index ${i}.`);
    const n = i - runStart + 1;
    const change = n > 1 ? quote - previous : 0;
    upStreak = change > 0 ? upStreak + 1 : 0;
    downStreak = change < 0 ? downStreak + 1 : 0;
    if (n > 1) absoluteSum += Math.abs(change);
    if (n > absoluteWindow + 1) {
      absoluteSum -= Math.abs(quotes[i - absoluteWindow] - quotes[i - absoluteWindow - 1]);
    }
    let difference = NaN, scale = 1;
    switch (name) {
      case "normalized-lag-momentum":
        if (n > base) difference = quote - quotes[i - base];
        scale = Math.sqrt(base);
        break;
      case "normalized-price-sma-distance":
        firstSum += quote;
        if (n > base) firstSum -= quotes[i - base];
        if (n >= base) difference = quote - firstSum / base;
        scale = Math.sqrt(base);
        break;
      case "normalized-tick-streak":
        if (n > base && (upStreak >= base || downStreak >= base)) {
          difference = quote - quotes[i - base];
        }
        scale = Math.sqrt(base);
        break;
      case "normalized-sma-spread": {
        const [fast, slow] = base;
        firstSum += quote;
        secondSum += quote;
        if (n > fast) firstSum -= quotes[i - fast];
        if (n > slow) secondSum -= quotes[i - slow];
        if (n >= slow) difference = firstSum / fast - secondSum / slow;
        scale = Math.sqrt(slow);
        break;
      }
      case "relative-tick-impulse":
        if (n > 1) difference = change;
        break;
      default: throw new Error(`Unknown additional-method family: ${name}`);
    }
    const meanAbsoluteChange = n > absoluteWindow ? absoluteSum / absoluteWindow : NaN;
    if (meanAbsoluteChange > 0 && Number.isFinite(difference)) {
      const direction = signDirection(difference);
      const strength = Math.abs(difference) / (meanAbsoluteChange * scale);
      for (let thresholdIndex = 0; thresholdIndex < family.thresholds.length; thresholdIndex += 1) {
        if (strength > family.thresholds[thresholdIndex]) {
          rows[2 * thresholdIndex][i] = direction;
          rows[2 * thresholdIndex + 1][i] = direction === 1 ? 2 : 1;
        }
      }
    }
    previous = quote;
  }
  return signals;
}

function evaluateTwoSegments({ quotes, present, signals, fromEpoch, edges, delays }) {
  const counts = new Map();
  for (const [methodId, methodSignals] of Object.entries(signals)) {
    for (const delayTicks of delays) {
      const first = replayForwardHalf({ quotes, present, signals: methodSignals, fromEpoch,
        startIndex: edges[0], endExclusive: edges[1], delayTicks, durationTicks: 5 }).counts;
      const second = replayForwardHalf({ quotes, present, signals: methodSignals, fromEpoch,
        startIndex: edges[1], endExclusive: edges[2], delayTicks, durationTicks: 5 }).counts;
      counts.set(`${methodId}/${delayTicks}`, [first, second]);
    }
  }
  return counts;
}

function rankAllMethods(ledger, ids, minimumTrades) {
  if (ids.length !== 550 || new Set(ids).size !== 550 || ledger.length !== 4_950) {
    throw new Error("Complete 550-method scenario ledger is required for ranking.");
  }
  const byMethod = new Map(ids.map((id) => [id, []]));
  for (const row of ledger) {
    if (!byMethod.has(row.methodId)) throw new Error(`Unexpected method: ${row.methodId}.`);
    byMethod.get(row.methodId).push(row);
  }
  const ranking = ids.map((methodId) => {
    const rows = byMethod.get(methodId);
    const primary = rows.filter((row) => row.profitOnWin === 0.8);
    const stress = rows.filter((row) => row.profitOnWin === 0.7);
    if (rows.length !== 9 || primary.length !== 3 || stress.length !== 3 ||
        rows.some((row) => row.segments.length !== 4)) {
      throw new Error(`Incomplete scenario matrix: ${methodId}.`);
    }
    const minimumTradesBySegment = minimumTrades.map((_, segment) =>
      Math.min(...primary.map((row) => row.segments[segment].settledTrades)));
    const sufficientTrades = minimumTrades.every((floor, segment) =>
      minimumTradesBySegment[segment] >= floor);
    const worstPrimaryReturn = Math.min(...primary.flatMap((row) => row.segments.map((item) =>
      item.averageProfitPerDollarStake ?? -Infinity)));
    const worstStressReturn = Math.min(...stress.flatMap((row) => row.segments.map((item) =>
      item.averageProfitPerDollarStake ?? -Infinity)));
    return { methodId, sufficientTrades, minimumTradesBySegment,
      worstPrimaryReturn, worstStressReturn,
      passesDevelopmentScreen: sufficientTrades && worstStressReturn > 0 };
  });
  ranking.sort((a, b) => Number(b.sufficientTrades) - Number(a.sufficientTrades) ||
    b.worstPrimaryReturn - a.worstPrimaryReturn || a.methodId.localeCompare(b.methodId));
  return { ranking: ranking.map((row, index) => ({ rank: index + 1, ...row })),
    provisionalTopThree: ranking.slice(0, 3).map((row) => row.methodId),
    developmentPassCount: ranking.filter((row) => row.passesDevelopmentScreen).length };
}

export async function runAdditional500Screen({ projectRoot, onProgress = () => {} }) {
  const marketDirectory = path.join(projectRoot, "data", "market");
  const reportDirectory = path.join(projectRoot, "data", "reports");
  const catalogBytes = await readFile(path.join(marketDirectory,
    "method-screen-500-additional-v1.json"));
  if (sha256(catalogBytes) !== CATALOG_SHA256) {
    throw new Error("Frozen 500-additional-method catalog checksum changed.");
  }
  const catalog = JSON.parse(catalogBytes);
  if (catalog.kind !== "bounded-bot-builder-additional-500-method-screen" ||
      catalog.symbol !== "1HZ100V" || catalog.endpoint !== PUBLIC_ENDPOINT ||
      catalog.timing.durationTicks !== 5 || catalog.timing.oneOpenContract !== true ||
      JSON.stringify(catalog.timing.processingDelayTicks) !== "[1,2,3]" ||
      JSON.stringify(catalog.payout.profitPerDollarOnWin) !== "[0.7,0.8,0.9]" ||
      catalog.botBuilderRunPermission !== false || catalog.demoOrderPermission !== false ||
      catalog.realOrderPermission !== false) {
    throw new Error("500-additional-method catalog safety lock changed.");
  }
  const groups = additionalMethodGroups(catalog);
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== catalog.symbol) throw new Error("Public-data safety lock changed.");
  const priorCatalogBytes = await readFile(path.join(marketDirectory, PRIOR_CATALOG));
  const priorBytes = await readFile(path.join(reportDirectory, PRIOR_REPORT));
  if (sha256(priorCatalogBytes) !== catalog.previousFiftyCatalogSha256 ||
      sha256(priorBytes) !== catalog.previousFiftyReportSha256) {
    throw new Error("Previous 50-method evidence checksum changed.");
  }
  const prior = JSON.parse(priorBytes);
  if (prior.kind !== "exploratory-fifty-method-screen" || prior.methodCount !== 50 ||
      prior.scenarioLedger.length !== 450 || prior.methodIds.length !== 50 ||
      prior.botBuilderRunPermission !== false || prior.demoOrderPermission !== false ||
      prior.realOrderPermission !== false) {
    throw new Error("Previous 50-method report changed or became unsafe.");
  }
  const newIds = groups.flatMap((group) => group.ids);
  if (newIds.some((id) => prior.methodIds.includes(id))) {
    throw new Error("An additional method duplicates one of the previous 50 IDs.");
  }
  const archiveWindow = catalog.series.archive;
  const archive = await auditForwardArchive({ projectRoot, symbol: catalog.symbol,
    fromEpoch: archiveWindow.fromEpoch, toEpochExclusive: archiveWindow.toEpochExclusive });
  if (archive.audit.observedGenuineSeconds !== archiveWindow.genuineSeconds ||
      archive.audit.missingSeconds !== archiveWindow.knownMissingSeconds ||
      archive.audit.manifestSha256 !== prior.data.thirtyDay.manifestSha256) {
    throw new Error("Thirty-day public archive integrity changed.");
  }
  const recoveryBytes = await readFile(path.join(reportDirectory, RECOVERY_REPORT));
  const pilotWindow = catalog.series.pilotComposite;
  if (sha256(recoveryBytes) !== pilotWindow.recoveryReportSha256) {
    throw new Error("Retrospective pilot recovery checksum changed.");
  }
  const recovery = JSON.parse(recoveryBytes);
  if (recovery.state !== "RECOVERED_SEPARATELY" || recovery.symbol !== catalog.symbol ||
      recovery.endpoint !== PUBLIC_ENDPOINT || recovery.fromEpoch !== pilotWindow.fromEpoch ||
      recovery.toEpochExclusive !== pilotWindow.toEpochExclusive ||
      recovery.recoveredRows !== pilotWindow.laterRecoveredSeconds ||
      recovery.stillMissingRows !== 0) {
    throw new Error("Retrospective pilot recovery provenance changed.");
  }
  const recovered = recovery.ranges.flatMap((range) => range.recovered);
  if (sha256(Buffer.from(JSON.stringify(recovered))) !== recovery.recoveredTicksSha256) {
    throw new Error("Recovered tick checksum changed.");
  }
  const originalPilot = await auditForwardArchive({ projectRoot, symbol: catalog.symbol,
    fromEpoch: pilotWindow.fromEpoch, toEpochExclusive: pilotWindow.toEpochExclusive });
  if (originalPilot.audit.manifestSha256 !== recovery.liveManifestSha256 ||
      originalPilot.audit.observedGenuineSeconds !== pilotWindow.originalLiveSeconds ||
      originalPilot.audit.missingSeconds !== pilotWindow.laterRecoveredSeconds) {
    throw new Error("Original public pilot archive changed.");
  }
  const composite = overlayVerifiedHistory(originalPilot.quotes, originalPilot.present,
    recovered, pilotWindow.fromEpoch);
  if (composite.added !== pilotWindow.laterRecoveredSeconds ||
      composite.present.some((item) => item !== 1)) {
    throw new Error("Retrospective pilot composite is incomplete.");
  }
  const archiveCuts = [Math.floor(archive.quotes.length * 0.7),
    Math.floor(archive.quotes.length * 0.85)];
  const pilotCut = Math.floor(composite.quotes.length / 2);
  const newLedger = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const archiveSignals = buildVariantGroupSignals(archive.quotes, archive.present,
      archiveCuts, group);
    const archiveCounts = evaluateTwoSegments({ ...archive, signals: archiveSignals,
      fromEpoch: archiveWindow.fromEpoch, edges: [archiveCuts[0], archiveCuts[1],
        archive.quotes.length], delays: catalog.timing.processingDelayTicks });
    const pilotSignals = buildVariantGroupSignals(composite.quotes, composite.present,
      [pilotCut], group);
    const pilotCounts = evaluateTwoSegments({ ...composite, signals: pilotSignals,
      fromEpoch: pilotWindow.fromEpoch, edges: [0, pilotCut, composite.quotes.length],
      delays: catalog.timing.processingDelayTicks });
    for (const methodId of group.ids) {
      for (const delayTicks of catalog.timing.processingDelayTicks) {
        const key = `${methodId}/${delayTicks}`;
        const counts = [...archiveCounts.get(key), ...pilotCounts.get(key)];
        for (const profitOnWin of catalog.payout.profitPerDollarOnWin) {
          newLedger.push({ methodId, delayTicks, profitOnWin,
            segments: counts.map((item) => scoreForwardCounts(item, profitOnWin)) });
        }
      }
    }
    if ((groupIndex + 1) % 5 === 0) {
      onProgress({ groupsDone: groupIndex + 1, groupsTotal: groups.length,
        newMethodsDone: (groupIndex + 1) * 10, newMethodsTotal: 500 });
    }
  }
  if (newLedger.length !== 4_500 || prior.scenarioLedger.length + newLedger.length !== 4_950) {
    throw new Error("Complete 550-method scenario ledger was not produced.");
  }
  const ledger = [...prior.scenarioLedger, ...newLedger];
  const ranking = rankAllMethods(ledger, [...prior.methodIds, ...newIds], [250, 250, 50, 50]);
  const positivePrimaryDiagnostics = ledger.filter((row) => row.profitOnWin === 0.8)
    .flatMap((row) => row.segments)
    .filter((segment) => segment.averageProfitPerDollarStake > 0).length;
  const report = {
    kind: "exploratory-additional-500-method-screen",
    generatedAtUtc: new Date().toISOString(), catalogSha256: CATALOG_SHA256,
    symbol: catalog.symbol, endpoint: PUBLIC_ENDPOINT,
    previousMethods: 50, additionalMethods: 500, totalMethods: 550,
    previousScenarios: 450, additionalScenarios: 4500, totalScenarios: 4950,
    previousReportSha256: sha256(priorBytes),
    recoveryReportSha256: sha256(recoveryBytes),
    segmentNames: ["thirtyDayMiddle", "thirtyDayLate", "pilotFirst", "pilotSecond"],
    sourceAudit: { thirtyDay: archive.audit, pilotOriginal: originalPilot.audit,
      historicalPilotSecondsAdded: composite.added, compositePilotSeconds: composite.quotes.length },
    newMethodIds: newIds, newScenarioLedger: newLedger,
    previousScenarioLedgerByReference: PRIOR_REPORT,
    positivePrimaryDiagnostics, totalPrimaryDiagnostics: 550 * 3 * 4,
    ...ranking,
    decision: ranking.developmentPassCount ?
      "RETROSPECTIVE_DEVELOPMENT_HITS_REQUIRE_UNTOUCHED_TEST" :
      "NO_TRADE_NO_DEVELOPMENT_PASS",
    evidenceLevel: "ADAPTIVE_RETROSPECTIVE_DEVELOPMENT_ONLY",
    observedExecutablePayouts: false, botBuilderParity: "UNVERIFIED",
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
    limitations: catalog.limitations,
  };
  const reportPath = path.join(reportDirectory,
    `method-screen-500-additional-${catalog.symbol}-${archiveWindow.fromEpoch}-${pilotWindow.toEpochExclusive}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
