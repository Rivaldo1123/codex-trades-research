import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditForwardArchive, replayForwardHalf, scoreForwardCounts } from "./forward-replay.js";
import { PUBLIC_ENDPOINT } from "./deriv-public.js";

const CATALOG_SHA256 = "d050e41582df2490095b6027fb490ec2e95c8e694a88f3416634b08736d99634";
const IDS = [
  "sma10-20-trend", "sma20-50-trend", "sma10-20-contrarian", "sma20-50-contrarian",
  "sma10-20-cross", "sma20-50-cross", "ema12-26-trend", "ema12-26-contrarian",
  "ema12-26-cross", "macd12-26-9-sign", "macd12-26-9-cross", "bb20-2-revert",
  "bb20-2-breakout", "bb20-2-reentry", "rsi14-30-70-revert", "rsi14-30-70-trend",
  "rsi14-50-cross", "rsi14-extreme-exit", "sma10-20-rsi50-confirm",
  "bb20-2-rsi-confirm",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function side(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return left > right ? 1 : left < right ? 2 : 0;
}

function reverse(direction) {
  return direction === 1 ? 2 : direction === 2 ? 1 : 0;
}

function crossover(previousA, previousB, currentA, currentB) {
  if (![previousA, previousB, currentA, currentB].every(Number.isFinite)) return 0;
  return previousA <= previousB && currentA > currentB ? 1 :
    previousA >= previousB && currentA < currentB ? 2 : 0;
}

function rsiFromAverages(gain, loss) {
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

export function buildTwentyMethodSignals(quotes, present, boundaries = []) {
  if (quotes.length !== present.length ||
      boundaries.some((index) => !Number.isSafeInteger(index) || index <= 0 || index >= quotes.length)) {
    throw new Error("Method screen quote, presence, or split dimensions are invalid.");
  }
  const signals = Object.fromEntries(IDS.map((id) => [id, new Uint8Array(quotes.length)]));
  const resetAt = new Set(boundaries);
  let runStart = 0;
  let sum10 = 0, sum12 = 0, sum20 = 0, sum26 = 0, sum50 = 0;
  let ema12 = NaN, ema26 = NaN, macdSignal = NaN, macdSum9 = 0, macdCount = 0;
  let gainSum = 0, lossSum = 0, averageGain = NaN, averageLoss = NaN;
  let prevQuote = NaN, prevSma10 = NaN, prevSma20 = NaN, prevSma50 = NaN;
  let prevEma12 = NaN, prevEma26 = NaN, prevMacd = NaN, prevMacdSignal = NaN;
  let prevLower = NaN, prevUpper = NaN, prevRsi = NaN;

  for (let i = 0; i < quotes.length; i += 1) {
    if (!present[i] || resetAt.has(i)) {
      runStart = i;
      sum10 = sum12 = sum20 = sum26 = sum50 = 0;
      ema12 = ema26 = macdSignal = NaN;
      macdSum9 = macdCount = 0;
      gainSum = lossSum = 0;
      averageGain = averageLoss = NaN;
      prevQuote = prevSma10 = prevSma20 = prevSma50 = NaN;
      prevEma12 = prevEma26 = prevMacd = prevMacdSignal = NaN;
      prevLower = prevUpper = prevRsi = NaN;
      if (!present[i]) { runStart = i + 1; continue; }
    }
    const quote = quotes[i];
    if (!Number.isFinite(quote)) throw new Error(`Invalid quote at index ${i}.`);
    const n = i - runStart + 1;
    sum10 += quote; if (n > 10) sum10 -= quotes[i - 10];
    sum12 += quote; if (n > 12) sum12 -= quotes[i - 12];
    sum20 += quote; if (n > 20) sum20 -= quotes[i - 20];
    sum26 += quote; if (n > 26) sum26 -= quotes[i - 26];
    sum50 += quote; if (n > 50) sum50 -= quotes[i - 50];
    const sma10 = n >= 10 ? sum10 / 10 : NaN;
    const sma20 = n >= 20 ? sum20 / 20 : NaN;
    const sma50 = n >= 50 ? sum50 / 50 : NaN;
    if (n === 12) ema12 = sum12 / 12;
    else if (n > 12) ema12 += (quote - ema12) * (2 / 13);
    if (n === 26) ema26 = sum26 / 26;
    else if (n > 26) ema26 += (quote - ema26) * (2 / 27);
    const macd = Number.isFinite(ema12) && Number.isFinite(ema26) ? ema12 - ema26 : NaN;
    if (Number.isFinite(macd)) {
      macdCount += 1;
      if (macdCount <= 9) macdSum9 += macd;
      if (macdCount === 9) macdSignal = macdSum9 / 9;
      else if (macdCount > 9) macdSignal += (macd - macdSignal) * 0.2;
    }
    if (n >= 2) {
      const delta = quote - prevQuote;
      const gain = Math.max(delta, 0);
      const loss = Math.max(-delta, 0);
      if (n <= 15) {
        gainSum += gain; lossSum += loss;
        if (n === 15) {
          averageGain = gainSum / 14;
          averageLoss = lossSum / 14;
        }
      } else {
        averageGain = (averageGain * 13 + gain) / 14;
        averageLoss = (averageLoss * 13 + loss) / 14;
      }
    }
    const rsi = n >= 15 ? rsiFromAverages(averageGain, averageLoss) : NaN;
    let lower = NaN, upper = NaN;
    if (n >= 20) {
      let squared = 0;
      for (let j = i - 19; j <= i; j += 1) {
        const difference = quotes[j] - sma20;
        squared += difference * difference;
      }
      const deviation = 2 * Math.sqrt(squared / 20);
      lower = sma20 - deviation;
      upper = sma20 + deviation;
    }
    const sma10vs20 = side(sma10, sma20);
    const sma20vs50 = side(sma20, sma50);
    const ema12vs26 = side(ema12, ema26);
    const macdVsSignal = side(macd, macdSignal);
    signals[IDS[0]][i] = sma10vs20;
    signals[IDS[1]][i] = sma20vs50;
    signals[IDS[2]][i] = reverse(sma10vs20);
    signals[IDS[3]][i] = reverse(sma20vs50);
    signals[IDS[4]][i] = crossover(prevSma10, prevSma20, sma10, sma20);
    signals[IDS[5]][i] = crossover(prevSma20, prevSma50, sma20, sma50);
    signals[IDS[6]][i] = ema12vs26;
    signals[IDS[7]][i] = reverse(ema12vs26);
    signals[IDS[8]][i] = crossover(prevEma12, prevEma26, ema12, ema26);
    signals[IDS[9]][i] = macdVsSignal;
    signals[IDS[10]][i] = crossover(prevMacd, prevMacdSignal, macd, macdSignal);
    signals[IDS[11]][i] = quote < lower ? 1 : quote > upper ? 2 : 0;
    signals[IDS[12]][i] = quote < lower ? 2 : quote > upper ? 1 : 0;
    signals[IDS[13]][i] = Number.isFinite(prevLower) &&
      prevQuote < prevLower && quote >= lower ? 1 :
      Number.isFinite(prevUpper) && prevQuote > prevUpper && quote <= upper ? 2 : 0;
    signals[IDS[14]][i] = rsi < 30 ? 1 : rsi > 70 ? 2 : 0;
    signals[IDS[15]][i] = rsi < 30 ? 2 : rsi > 70 ? 1 : 0;
    signals[IDS[16]][i] = crossover(prevRsi, 50, rsi, 50);
    signals[IDS[17]][i] = Number.isFinite(prevRsi) && prevRsi < 30 && rsi >= 30 ? 1 :
      Number.isFinite(prevRsi) && prevRsi > 70 && rsi <= 70 ? 2 : 0;
    signals[IDS[18]][i] = sma10vs20 === 1 && rsi > 50 ? 1 :
      sma10vs20 === 2 && rsi < 50 ? 2 : 0;
    signals[IDS[19]][i] = quote < lower && rsi < 30 ? 1 :
      quote > upper && rsi > 70 ? 2 : 0;
    prevQuote = quote;
    prevSma10 = sma10; prevSma20 = sma20; prevSma50 = sma50;
    prevEma12 = ema12; prevEma26 = ema26;
    prevMacd = macd; prevMacdSignal = macdSignal;
    prevLower = lower; prevUpper = upper; prevRsi = rsi;
  }
  return signals;
}

export function rankTwentyMethods(ledger, ids = IDS, minTrades = 250) {
  const rows = ids.map((id) => {
    const primary = ledger.filter((row) => row.methodId === id && row.profitOnWin === 0.8);
    const stress = ledger.filter((row) => row.methodId === id && row.profitOnWin === 0.7);
    if (primary.length !== 3 || stress.length !== 3) throw new Error(`Incomplete ledger for ${id}.`);
    const minimumMiddleReturn = Math.min(...primary.map((row) =>
      row.middle.averageProfitPerDollarStake ?? -Infinity));
    const minimumMiddleTrades = Math.min(...primary.map((row) => row.middle.settledTrades));
    const minimumLateReturn = Math.min(...primary.map((row) =>
      row.late.averageProfitPerDollarStake ?? -Infinity));
    const minimumLateStressReturn = Math.min(...stress.map((row) =>
      row.late.averageProfitPerDollarStake ?? -Infinity));
    return { methodId: id, minimumMiddleReturn, minimumMiddleTrades,
      minimumLateReturn, minimumLateStressReturn,
      passesDevelopmentScreen: minimumMiddleTrades >= minTrades &&
        minimumMiddleReturn > 0 && minimumLateReturn > 0 &&
        minimumLateStressReturn > 0 };
  });
  rows.sort((a, b) => (b.minimumMiddleTrades >= minTrades ? b.minimumMiddleReturn : -Infinity) -
    (a.minimumMiddleTrades >= minTrades ? a.minimumMiddleReturn : -Infinity) ||
    a.methodId.localeCompare(b.methodId));
  return { ranking: rows.map((row, index) => ({ rank: index + 1, ...row })),
    provisionalTopThree: rows.slice(0, 3).map((row) => row.methodId),
    developmentPassCount: rows.filter((row) => row.passesDevelopmentScreen).length };
}

export async function runTwentyMethodScreen({ projectRoot }) {
  const catalogPath = path.join(projectRoot, "data", "market", "method-screen-20-v1.json");
  const catalogBytes = await readFile(catalogPath);
  if (sha256(catalogBytes) !== CATALOG_SHA256) throw new Error("Frozen 20-method catalog checksum changed.");
  const catalog = JSON.parse(catalogBytes);
  if (catalog.kind !== "bounded-bot-builder-method-screen" || catalog.symbol !== "1HZ100V" ||
      catalog.methods.length !== 20 || catalog.methods.some((item, index) => item.id !== IDS[index]) ||
      catalog.timing.durationTicks !== 5 || catalog.timing.oneOpenContract !== true ||
      catalog.botBuilderRunPermission !== false || catalog.demoOrderPermission !== false ||
      catalog.realOrderPermission !== false) throw new Error("Twenty-method catalog safety or method set changed.");
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== catalog.symbol) throw new Error("Public-data safety lock changed.");
  const { fromEpoch, toEpochExclusive } = catalog.developmentWindow;
  const { quotes, present, audit } = await auditForwardArchive({ projectRoot,
    symbol: catalog.symbol, fromEpoch, toEpochExclusive });
  if (audit.expectedSeconds !== 2_592_000 || audit.observedGenuineSeconds !== 2_591_993 ||
      audit.missingSeconds !== 7 || audit.missingRanges.length !== 1 ||
      audit.missingRanges[0].fromEpoch !== 1_789_085_201 ||
      audit.missingRanges[0].toEpochExclusive !== 1_789_085_208) {
    throw new Error("Thirty-day development archive differs from its known seven-second gap.");
  }
  const middleStart = fromEpoch + Math.floor(audit.expectedSeconds * 0.7);
  const lateStart = fromEpoch + Math.floor(audit.expectedSeconds * 0.85);
  const boundaries = [middleStart - fromEpoch, lateStart - fromEpoch];
  const signals = buildTwentyMethodSignals(quotes, present, boundaries);
  const ledger = [];
  for (const method of catalog.methods) {
    for (const delayTicks of catalog.timing.processingDelayTicks) {
      const base = { quotes, present, signals: signals[method.id], fromEpoch,
        delayTicks, durationTicks: 5 };
      const counts = [
        replayForwardHalf({ ...base, startIndex: 0, endExclusive: boundaries[0] }).counts,
        replayForwardHalf({ ...base, startIndex: boundaries[0], endExclusive: boundaries[1] }).counts,
        replayForwardHalf({ ...base, startIndex: boundaries[1], endExclusive: quotes.length }).counts,
      ];
      for (const profitOnWin of catalog.payout.profitPerDollarOnWin) {
        ledger.push({ methodId: method.id, delayTicks, profitOnWin,
          early: scoreForwardCounts(counts[0], profitOnWin),
          middle: scoreForwardCounts(counts[1], profitOnWin),
          late: scoreForwardCounts(counts[2], profitOnWin) });
      }
    }
  }
  if (ledger.length !== 180) throw new Error("The 20-method scenario ledger is incomplete.");
  const ranking = rankTwentyMethods(ledger);
  const report = { kind: "exploratory-twenty-method-screen",
    generatedAtUtc: new Date().toISOString(), catalogSha256: CATALOG_SHA256,
    source: "Deriv public tick archive; all dates previously viewed",
    audit, splits: { early: [fromEpoch, middleStart], middle: [middleStart, lateStart],
      late: [lateStart, toEpochExclusive] },
    methodDefinitions: catalog.methods, scenarioLedger: ledger, ...ranking,
    decision: "NO_TRADE_PENDING_UNTOUCHED_FORWARD_VALIDATION",
    botBuilderParity: "UNVERIFIED", observedExecutablePayouts: false,
    botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false,
    limitations: ["The ranking is exploratory because the 30-day archive was already inspected.",
      "The seven missing seconds stay absent and all indicator state resets at that gap.",
      "The platform's indicator and tick-timing parity has not been observed.",
      "Public quotes and assumed payouts are not executable contract terms."] };
  const reportPath = path.join(projectRoot, "data", "reports",
    `method-screen-20-${catalog.symbol}-${fromEpoch}-${toEpochExclusive}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
