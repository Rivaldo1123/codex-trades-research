import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";
import { replayForwardHalf, scoreForwardCounts } from "./forward-replay.js";
import { buildTwentyMethodSignals } from "./method-screen-20.js";
import { buildThirtyNewMethodSignals } from "./method-screen-50.js";
import { additionalMethodGroups, buildVariantGroupSignals } from "./method-screen-500.js";
import { CROSS_VOLATILITY_PROTOCOL_SHA256, CROSS_VOLATILITY_V2_PROTOCOL_SHA256,
  loadCrossVolatilityProtocol, loadCrossVolatilityProtocolV2,
  readStoredCrossVolatilityPages } from "./cross-volatility-collector.js";

const PRIOR_FIFTY_REPORT = "method-screen-50-1HZ100V-1788667200-1791417600.json";
const PRIOR_FIVE_HUNDRED_REPORT =
  "method-screen-500-additional-1HZ100V-1788667200-1791417600.json";
const ADDITIONAL_CATALOG = "method-screen-500-additional-v1.json";
const ADDITIONAL_CATALOG_SHA256 =
  "9f45a2b73a4880edac58f9f89e565b01f81819dbd533378285752c177ec9d24a";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function quoteSeriesFromPages(pages, symbolSpec, protocol,
  { allowGaps = false } = {}) {
  const quotes = new Float64Array(symbolSpec.expectedTicks);
  const present = new Uint8Array(quotes.length);
  let cursor = 0;
  const hasher = createHash("sha256");
  for (const page of pages) {
    for (const [epoch, quote] of page.ticks) {
      const slot = (epoch - protocol.fromEpoch) / symbolSpec.secondsPerTick;
      if (!Number.isSafeInteger(slot) || slot < cursor || slot >= quotes.length ||
          (!allowGaps && slot !== cursor) || !Number.isFinite(quote)) {
        throw new Error(`Cross-volatility row gap, overlap or invalid quote: ${symbolSpec.symbol}.`);
      }
      quotes[slot] = quote;
      present[slot] = 1;
      hasher.update(`${epoch},${quote}\n`);
      cursor = slot + 1;
    }
  }
  if (!allowGaps && cursor !== symbolSpec.expectedTicks) {
    throw new Error(`Incomplete cross-volatility quote series: ${symbolSpec.symbol}.`);
  }
  return { quotes, present, observedTicks: present.reduce((sum, value) => sum + value, 0),
    rowSha256: hasher.digest("hex") };
}

function scoreSignals({ symbol, quotes, present, signals, fromEpoch, midpoint,
  delays, payouts }) {
  const rows = [];
  for (const [methodId, methodSignals] of Object.entries(signals)) {
    for (const delayTicks of delays) {
      const first = replayForwardHalf({ quotes, present, signals: methodSignals, fromEpoch,
        startIndex: 0, endExclusive: midpoint, delayTicks, durationTicks: 5 }).counts;
      const second = replayForwardHalf({ quotes, present, signals: methodSignals, fromEpoch,
        startIndex: midpoint, endExclusive: quotes.length, delayTicks, durationTicks: 5 }).counts;
      for (const profitOnWin of payouts) {
        rows.push({ symbol, methodId, delayTicks, profitOnWin,
          first: scoreForwardCounts(first, profitOnWin),
          second: scoreForwardCounts(second, profitOnWin) });
      }
    }
  }
  return rows;
}

export function rankCrossVolatilitySymbol(rows, methodIds, minimumTrades = 100) {
  if (methodIds.length !== 550 || new Set(methodIds).size !== 550 ||
      rows.length !== 4_950) {
    throw new Error("Cross-volatility 550-method scenario matrix is incomplete.");
  }
  const byMethod = new Map(methodIds.map((id) => [id, []]));
  const keys = new Set();
  for (const row of rows) {
    const key = `${row.methodId}/${row.delayTicks}/${row.profitOnWin}`;
    if (!byMethod.has(row.methodId) || keys.has(key) ||
        ![1, 2, 3].includes(row.delayTicks) ||
        ![0.7, 0.8, 0.9].includes(row.profitOnWin)) {
      throw new Error(`Duplicate or invalid cross-volatility scenario: ${key}.`);
    }
    keys.add(key);
    byMethod.get(row.methodId).push(row);
  }
  const ranking = methodIds.map((methodId) => {
    const variants = byMethod.get(methodId);
    const primary = variants.filter((row) => row.profitOnWin === 0.8);
    const stress = variants.filter((row) => row.profitOnWin === 0.7);
    if (variants.length !== 9 || primary.length !== 3 || stress.length !== 3) {
      throw new Error(`Missing delays or payouts for ${methodId}.`);
    }
    const minimumFirstTrades = Math.min(...primary.map((row) => row.first.settledTrades));
    const minimumSecondTrades = Math.min(...primary.map((row) => row.second.settledTrades));
    const sufficientlyObserved = minimumFirstTrades >= minimumTrades &&
      minimumSecondTrades >= minimumTrades;
    const worstPrimaryReturn = Math.min(...primary.flatMap((row) => [
      row.first.averageProfitPerDollarStake ?? -Infinity,
      row.second.averageProfitPerDollarStake ?? -Infinity]));
    const worstStressReturn = Math.min(...stress.flatMap((row) => [
      row.first.averageProfitPerDollarStake ?? -Infinity,
      row.second.averageProfitPerDollarStake ?? -Infinity]));
    return { methodId, sufficientlyObserved, minimumFirstTrades, minimumSecondTrades,
      worstPrimaryReturn, worstStressReturn,
      passesExploratoryScreen: sufficientlyObserved && worstStressReturn > 0 };
  });
  ranking.sort((a, b) => Number(b.sufficientlyObserved) - Number(a.sufficientlyObserved) ||
    b.worstPrimaryReturn - a.worstPrimaryReturn || a.methodId.localeCompare(b.methodId));
  return { ranking, exploratoryPassCount: ranking.filter((row) =>
    row.passesExploratoryScreen).length,
  bestObserved: ranking[0] };
}

export async function runCrossVolatilityScreen({ projectRoot, onProgress = () => {},
  studyVersion = 1 }) {
  if (![1, 2].includes(studyVersion)) throw new Error("Unknown cross-volatility study version.");
  const isGapAware = studyVersion === 2;
  const protocol = isGapAware ? await loadCrossVolatilityProtocolV2(projectRoot) :
    await loadCrossVolatilityProtocol(projectRoot);
  const protocolSha256 = isGapAware ? CROSS_VOLATILITY_V2_PROTOCOL_SHA256 :
    CROSS_VOLATILITY_PROTOCOL_SHA256;
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== "1HZ100V") throw new Error("Public-only safety lock changed.");
  const reportDirectory = path.join(projectRoot, "data", "reports");
  const marketDirectory = path.join(projectRoot, "data", "market");
  const studyRoot = path.join(marketDirectory, isGapAware ?
    "cross-volatility-24h-v2-gap-aware" : "cross-volatility-24h-v1");
  const collectionBytes = await readFile(path.join(studyRoot, "collection-report.json"));
  const collection = JSON.parse(collectionBytes);
  const status = JSON.parse(await readFile(path.join(studyRoot, "status.json"), "utf8"));
  if (collection.kind !== "public-cross-volatility-collection-report" ||
      collection.state !== "COMPLETED" || collection.symbolCount !== 13 ||
      collection.totalExpectedTicks !== 907_200 ||
      collection.totalObservedTicks > 907_200 ||
      collection.totalObservedTicks < 907_200 * (isGapAware ? 0.999 : 1) ||
      collection.protocolSha256 !== protocolSha256 ||
      collection.endpoint !== PUBLIC_ENDPOINT ||
      status.state !== "COMPLETED" ||
      status.protocolSha256 !== protocolSha256) {
    throw new Error("All thirteen public tick archives have not completed their audit.");
  }
  const priorFiftyBytes = await readFile(path.join(reportDirectory, PRIOR_FIFTY_REPORT));
  const priorFiveHundredBytes = await readFile(path.join(reportDirectory,
    PRIOR_FIVE_HUNDRED_REPORT));
  const additionalCatalogBytes = await readFile(path.join(marketDirectory, ADDITIONAL_CATALOG));
  if (sha256(priorFiftyBytes) !== protocol.evaluation.priorFiftyReportSha256 ||
      sha256(priorFiveHundredBytes) !== protocol.evaluation.priorAdditional500ReportSha256 ||
      sha256(additionalCatalogBytes) !== ADDITIONAL_CATALOG_SHA256) {
    throw new Error("Frozen 550-method source evidence checksum changed.");
  }
  const priorFifty = JSON.parse(priorFiftyBytes);
  const priorFiveHundred = JSON.parse(priorFiveHundredBytes);
  const additionalCatalog = JSON.parse(additionalCatalogBytes);
  const groups = additionalMethodGroups(additionalCatalog);
  const expectedIds = [...priorFifty.methodIds, ...groups.flatMap((group) => group.ids)];
  if (priorFifty.methodCount !== 50 || priorFiveHundred.additionalMethods !== 500 ||
      priorFiveHundred.totalMethods !== 550 || new Set(expectedIds).size !== 550) {
    throw new Error("Frozen method IDs changed or overlap.");
  }
  const perSymbol = [];
  const allRows = [];
  for (const symbolSpec of protocol.symbols) {
    const recorded = collection.symbols.find((item) => item.symbol === symbolSpec.symbol);
    if (!recorded || recorded.expectedTicks !== symbolSpec.expectedTicks ||
        recorded.coverageRate < (isGapAware ? 0.999 : 1) ||
        recorded.state === "INCOMPLETE") {
      throw new Error(`Incomplete collection report for ${symbolSpec.symbol}.`);
    }
    const pages = await readStoredCrossVolatilityPages(studyRoot, symbolSpec, protocol,
      { protocolSha256, allowGaps: isGapAware });
    const series = quoteSeriesFromPages(pages, symbolSpec, protocol,
      { allowGaps: isGapAware });
    if (series.rowSha256 !== recorded.rowSha256 || pages.length !== recorded.pageCount ||
        series.observedTicks !== recorded.observedTicks) {
      throw new Error(`Archived row checksum or page count changed for ${symbolSpec.symbol}.`);
    }
    const midpoint = series.quotes.length / 2;
    if (!Number.isInteger(midpoint)) throw new Error("Odd tick count cannot be split exactly.");
    const baseSignals = { ...buildTwentyMethodSignals(series.quotes, series.present,
      [midpoint]), ...buildThirtyNewMethodSignals(series.quotes, series.present, [midpoint]) };
    const rows = scoreSignals({ symbol: symbolSpec.symbol, ...series, signals: baseSignals,
      fromEpoch: protocol.fromEpoch, midpoint,
      delays: protocol.evaluation.delaysTicks,
      payouts: protocol.evaluation.winProfitPerDollarStake });
    for (const group of groups) {
      const signals = buildVariantGroupSignals(series.quotes, series.present,
        [midpoint], group);
      rows.push(...scoreSignals({ symbol: symbolSpec.symbol, ...series, signals,
        fromEpoch: protocol.fromEpoch, midpoint,
        delays: protocol.evaluation.delaysTicks,
        payouts: protocol.evaluation.winProfitPerDollarStake }));
    }
    const ranked = rankCrossVolatilitySymbol(rows, expectedIds,
      protocol.evaluation.minimumSettledTradesPerHalfPerDelay);
    allRows.push(...rows);
    perSymbol.push({ symbol: symbolSpec.symbol, name: symbolSpec.name,
      secondsPerTick: symbolSpec.secondsPerTick, expectedTicks: symbolSpec.expectedTicks,
      observedTicks: recorded.observedTicks, missingTicks: recorded.missingTicks,
      coverageRate: recorded.coverageRate, missingRanges: recorded.missingRanges,
      pageCount: recorded.pageCount, rowSha256: recorded.rowSha256,
      scenarioCount: rows.length, exploratoryPassCount: ranked.exploratoryPassCount,
      bestObserved: ranked.bestObserved,
      provisionalTopThree: ranked.ranking.slice(0, 3) });
    onProgress({ symbolsDone: perSymbol.length, symbolsTotal: protocol.symbols.length,
      symbol: symbolSpec.symbol, exploratoryPassCount: ranked.exploratoryPassCount });
  }
  if (allRows.length !== 64_350 || perSymbol.length !== 13) {
    throw new Error("Complete thirteen-symbol scenario ledger was not produced.");
  }
  const exploratoryHits = perSymbol.reduce((sum, symbol) => sum + symbol.exploratoryPassCount, 0);
  const report = { kind: "cross-volatility-24h-exploratory-screen",
    studyVersion,
    generatedAtUtc: new Date().toISOString(),
    protocolSha256,
    collectionReportSha256: sha256(collectionBytes), endpoint: PUBLIC_ENDPOINT,
    fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive,
    symbolCount: 13, methodCountPerSymbol: 550, scenarioCount: allRows.length,
    totalVerifiedTicks: collection.totalObservedTicks,
    assumedProfitPerDollarOnWin: protocol.evaluation.winProfitPerDollarStake,
    symbolSummaries: perSymbol, scenarioLedger: allRows,
    exploratoryHitCount: exploratoryHits,
    decision: exploratoryHits ? "RETROSPECTIVE_HITS_REQUIRE_PROSPECTIVE_VALIDATION" :
      "NO_TRADE_NO_CROSS_SYMBOL_DEVELOPMENT_PASS",
    evidenceLevel: "ADAPTIVE_RETROSPECTIVE_ONE_DAY_CROSS_SECTION_ONLY",
    observedExecutablePayouts: false, botBuilderParity: "UNVERIFIED",
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
    limitations: ["The previous 550 variants were chosen after viewing 1HZ100V; this is not a pristine discovery experiment.",
      "Thirteen instruments times 550 correlated variants create thousands of comparisons; an isolated positive score can occur by chance.",
      "The 24-hour interval is retrospective and too short to establish stable profitability.",
      ...(isGapAware ? ["Source-missing ticks remain absent; indicators reset and no replayed contract crosses them."] : []),
      "Actual executable payouts and Deriv Bot indicator/tick timing have not been verified."] };
  const reportPath = path.join(reportDirectory,
    `cross-volatility-24h-v${studyVersion}-550-methods-${protocol.fromEpoch}-${protocol.toEpochExclusive}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
