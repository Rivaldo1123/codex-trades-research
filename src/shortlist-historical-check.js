import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";
import { renameStatusFileWithRetry } from "./atomic-status.js";
import { replayForwardHalf, scoreForwardCounts,
  hourlyBootstrapLowerBound } from "./forward-replay.js";
import { additionalMethodGroups, buildVariantGroupSignals } from "./method-screen-500.js";

export const SHORTLIST_PROTOCOL_SHA256 =
  "05ca7e276df60ac91b124b26cf021206f307b8d008eb3cfa83d38cf53034662f";
const STUDY_NAME = "shortlist-historical-check-v1";
const PAGE_NAME = /^page-(\d+)-(\d+)-([0-9a-f]{64})\.json\.gz$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateShortlistProtocol(protocol) {
  const expected = [
    ["R_50", 2, "normalized-price-sma-distance-34-1.5-reverse"],
    ["1HZ10V", 1, "normalized-tick-streak-8-0.25-reverse"],
    ["R_100", 2, "normalized-sma-spread-89-233-1-trend"],
  ];
  if (protocol.kind !== "public-only-frozen-shortlist-historical-check" ||
      protocol.version !== 1 || protocol.mode !== "public-data-only" ||
      protocol.endpoint !== PUBLIC_ENDPOINT || protocol.fromEpoch !== 1_791_165_600 ||
      protocol.toEpochExclusive !== 1_791_338_400 ||
      protocol.sourceDiscoveryReportSha256 !==
        "26c3f9c3d128e81ae098d634b709549290f532bbb9a482b78d49025bea1eb847" ||
      JSON.stringify(protocol.candidates?.map((item) =>
        [item.symbol, item.secondsPerTick, item.methodId])) !== JSON.stringify(expected) ||
      protocol.collection?.pageSize !== 1000 ||
      protocol.collection.minimumInterRequestMs !== 1500 ||
      protocol.collection.maximumConsecutiveRetries !== 8 ||
      protocol.collection.minimumCoverageRatePerSymbol !== 0.999 ||
      protocol.evaluation?.durationTicks !== 5 ||
      protocol.evaluation.oneOpenContract !== true ||
      JSON.stringify(protocol.evaluation.entryDelayTicks) !== "[1,2,3]" ||
      JSON.stringify(protocol.evaluation.winProfitPerDollarStake) !== "[0.8,0.9,0.95]" ||
      protocol.evaluation.stressWinProfitPerDollarStake !== 0.9 ||
      protocol.evaluation.minimumSettledTradesPerHalfPerDelay !== 100 ||
      protocol.evaluation.requirePositiveEveryHalfAndDelayAtStressPayout !== true ||
      protocol.evaluation.allowNoTrade !== true ||
      protocol.botBuilderRunPermission !== false ||
      protocol.demoOrderPermission !== false || protocol.realOrderPermission !== false) {
    throw new Error("Frozen shortlist public-only protocol changed.");
  }
  return protocol;
}

export async function loadShortlistProtocol(projectRoot) {
  const bytes = await readFile(path.join(projectRoot, "data", "market",
    "shortlist-historical-check-v1.json"));
  if (sha256(bytes) !== SHORTLIST_PROTOCOL_SHA256) {
    throw new Error("Frozen shortlist protocol checksum changed.");
  }
  const protocol = validateShortlistProtocol(JSON.parse(bytes));
  const sourceBytes = await readFile(path.join(projectRoot, "data", "reports",
    "cross-volatility-24h-v2-550-methods-1791338400-1791424800.json"));
  if (sha256(sourceBytes) !== protocol.sourceDiscoveryReportSha256) {
    throw new Error("Shortlist discovery source checksum changed.");
  }
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== "1HZ100V") throw new Error("Public-only safety lock changed.");
  return protocol;
}

export function studyRootFor(projectRoot) {
  return path.join(projectRoot, "data", "market", STUDY_NAME);
}

function validatePage(page, spec, protocol) {
  if (page.kind !== "public-shortlist-historical-tick-page" ||
      page.protocolSha256 !== SHORTLIST_PROTOCOL_SHA256 ||
      page.endpoint !== PUBLIC_ENDPOINT || page.symbol !== spec.symbol ||
      page.fromEpoch !== protocol.fromEpoch ||
      page.toEpochExclusive !== protocol.toEpochExclusive ||
      !Array.isArray(page.ticks) || !page.ticks.length || page.ticks.length > 1000) {
    throw new Error(`Invalid archived page for ${spec.symbol}.`);
  }
  let previous = null;
  for (const [epoch, quote] of page.ticks) {
    if (!Number.isSafeInteger(epoch) || !Number.isFinite(quote) ||
        epoch < protocol.fromEpoch || epoch >= protocol.toEpochExclusive ||
        (epoch - protocol.fromEpoch) % spec.secondsPerTick !== 0 ||
        (previous !== null && epoch <= previous)) {
      throw new Error(`Invalid or overlapping ${spec.symbol} tick row.`);
    }
    previous = epoch;
  }
  return { firstEpoch: page.ticks[0][0], lastEpoch: previous,
    rows: page.ticks.length };
}

export async function readShortlistPages(projectRoot, spec, protocol) {
  const directory = path.join(studyRootFor(projectRoot), spec.symbol);
  await mkdir(directory, { recursive: true });
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json.gz"));
  const pages = [];
  for (const file of files) {
    const name = PAGE_NAME.exec(file);
    if (!name) throw new Error(`Unknown shortlist page: ${file}`);
    const bytes = await readFile(path.join(directory, file));
    if (sha256(bytes) !== name[3]) throw new Error(`Shortlist page checksum failed: ${file}`);
    const page = JSON.parse(gunzipSync(bytes));
    const meta = validatePage(page, spec, protocol);
    if (meta.firstEpoch !== Number(name[1]) || meta.lastEpoch !== Number(name[2])) {
      throw new Error(`Shortlist page name mismatch: ${file}`);
    }
    pages.push({ file, ...meta, ticks: page.ticks });
  }
  pages.sort((a, b) => a.firstEpoch - b.firstEpoch);
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i].firstEpoch <= pages[i - 1].lastEpoch) {
      throw new Error(`Shortlist page overlap: ${spec.symbol}`);
    }
  }
  return pages;
}

export function auditShortlistPages(pages, spec, protocol) {
  const expectedTicks = (protocol.toEpochExclusive - protocol.fromEpoch) / spec.secondsPerTick;
  const missingRanges = [];
  const hasher = createHash("sha256");
  let expectedEpoch = protocol.fromEpoch, observedTicks = 0;
  for (const page of pages) for (const [epoch, quote] of page.ticks) {
    if (epoch < expectedEpoch || (epoch - expectedEpoch) % spec.secondsPerTick !== 0) {
      throw new Error(`Shortlist ordering or tick cadence failed: ${spec.symbol}`);
    }
    if (epoch > expectedEpoch) missingRanges.push({ fromEpoch: expectedEpoch,
      toEpochExclusive: epoch,
      missingTicks: (epoch - expectedEpoch) / spec.secondsPerTick });
    hasher.update(`${epoch},${quote}\n`);
    observedTicks += 1;
    expectedEpoch = epoch + spec.secondsPerTick;
  }
  if (expectedEpoch < protocol.toEpochExclusive) {
    missingRanges.push({ fromEpoch: expectedEpoch,
      toEpochExclusive: protocol.toEpochExclusive,
      missingTicks: (protocol.toEpochExclusive - expectedEpoch) / spec.secondsPerTick });
  }
  const coverageRate = observedTicks / expectedTicks;
  return { symbol: spec.symbol, expectedTicks, observedTicks,
    missingTicks: expectedTicks - observedTicks, missingRanges, coverageRate,
    pageCount: pages.length, rowSha256: hasher.digest("hex"),
    state: coverageRate >= protocol.collection.minimumCoverageRatePerSymbol ?
      missingRanges.length ? "PASS_WITH_GAPS" : "COMPLETE" : "INCOMPLETE" };
}

async function savePage(projectRoot, spec, protocol, ticks) {
  const page = { kind: "public-shortlist-historical-tick-page",
    protocolSha256: SHORTLIST_PROTOCOL_SHA256, endpoint: PUBLIC_ENDPOINT,
    symbol: spec.symbol, fromEpoch: protocol.fromEpoch,
    toEpochExclusive: protocol.toEpochExclusive,
    ticks: ticks.map(({ epoch, quote }) => [epoch, quote]) };
  const meta = validatePage(page, spec, protocol);
  const bytes = gzipSync(Buffer.from(JSON.stringify(page)));
  const file = `page-${meta.firstEpoch}-${meta.lastEpoch}-${sha256(bytes)}.json.gz`;
  await writeFile(path.join(studyRootFor(projectRoot), spec.symbol, file), bytes,
    { flag: "wx" });
  return { file, ...meta, ticks: page.ticks };
}

async function writeStatus(studyRoot, status) {
  const file = path.join(studyRoot, "status.json");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...status,
    updatedAtUtc: new Date().toISOString() }, null, 2)}\n`);
  await renameStatusFileWithRetry(temporary, file);
}

export async function collectShortlistHistory({ projectRoot,
  clientFactory = () => new DerivPublicClient(), onProgress = () => {} }) {
  const protocol = await loadShortlistProtocol(projectRoot);
  if (protocol.toEpochExclusive > Math.floor(Date.now() / 1000)) {
    throw new Error("Shortlist historical window has not closed.");
  }
  const studyRoot = studyRootFor(projectRoot);
  await mkdir(studyRoot, { recursive: true });
  const lockPath = path.join(studyRoot, "collector.lock");
  const lock = await open(lockPath, "wx");
  await lock.writeFile(`${process.pid}\n`);
  let client = clientFactory();
  const status = { kind: "public-shortlist-historical-collection-status",
    protocolSha256: SHORTLIST_PROTOCOL_SHA256, mode: "public-data-only",
    endpoint: PUBLIC_ENDPOINT, state: "STARTING", pid: process.pid,
    currentSymbol: null, symbolsCompleted: 0, pagesStored: 0, rowsStored: 0,
    lastError: null, retryAtUtc: null, startedAtUtc: new Date().toISOString() };
  const update = async (patch) => {
    Object.assign(status, patch);
    await writeStatus(studyRoot, status);
    onProgress(status);
  };
  try {
    await update({});
    await client.connect();
    const summaries = [];
    for (const spec of protocol.candidates) {
      await update({ state: "RUNNING", currentSymbol: spec.symbol });
      const pages = await readShortlistPages(projectRoot, spec, protocol);
      let cursor = pages.length ? pages[0].firstEpoch - 1 : protocol.toEpochExclusive - 1;
      let retries = 0;
      while (cursor >= protocol.fromEpoch) {
        let ticks;
        try {
          await client.connect();
          ticks = await client.getTicksHistory(spec.symbol, { count: 1000,
            start: protocol.fromEpoch, end: cursor });
          retries = 0;
        } catch (error) {
          retries += 1;
          if (retries > protocol.collection.maximumConsecutiveRetries ||
              !/RateLimit|rate limit|timed out|connect|WebSocket closed/i.test(String(error))) {
            throw error;
          }
          const backoff = Math.min(300_000, 5_000 * 2 ** Math.min(retries - 1, 6));
          await update({ state: "BACKING_OFF", lastError: String(error),
            retryAtUtc: new Date(Date.now() + backoff).toISOString() });
          client.close();
          await sleep(backoff);
          client = clientFactory();
          await update({ state: "RUNNING", retryAtUtc: null });
          continue;
        }
        if (!ticks.length) break;
        if (ticks.at(-1).epoch > cursor ||
            (pages.length && ticks.at(-1).epoch >= pages[0].firstEpoch)) {
          throw new Error(`Shortlist historical page overlaps or exceeds cursor: ${spec.symbol}`);
        }
        const page = await savePage(projectRoot, spec, protocol, ticks);
        pages.unshift(page);
        cursor = page.firstEpoch - 1;
        await update({ state: "RUNNING", pagesStored: status.pagesStored + 1,
          rowsStored: status.rowsStored + page.rows, lastError: null, retryAtUtc: null,
          lastPage: { symbol: spec.symbol, firstEpoch: page.firstEpoch,
            lastEpoch: page.lastEpoch, rows: page.rows } });
        await sleep(protocol.collection.minimumInterRequestMs);
      }
      const summary = auditShortlistPages(pages, spec, protocol);
      summaries.push(summary);
      await update({ symbolsCompleted: summaries.length, lastCompletedSymbol: summary });
    }
    const report = { kind: "public-shortlist-historical-collection-report",
      generatedAtUtc: new Date().toISOString(),
      protocolSha256: SHORTLIST_PROTOCOL_SHA256, endpoint: PUBLIC_ENDPOINT,
      fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive,
      symbols: summaries,
      state: summaries.every((summary) => summary.state !== "INCOMPLETE") ?
        "COMPLETED" : "INCOMPLETE",
      botBuilderRunPermission: false, demoOrderPermission: false,
      realOrderPermission: false };
    const reportPath = path.join(studyRoot, "collection-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await update({ state: report.state, currentSymbol: null, reportPath });
    return { report, reportPath };
  } catch (error) {
    await update({ state: "FAILED", lastError: String(error), retryAtUtc: null });
    throw error;
  } finally {
    client.close();
    await lock.close();
    await unlink(lockPath);
  }
}

function combineHourly(first, second) {
  const combined = new Map(first);
  for (const [hour, block] of second) {
    const prior = combined.get(hour) ?? { wins: 0, losses: 0 };
    combined.set(hour, { wins: prior.wins + block.wins,
      losses: prior.losses + block.losses });
  }
  return combined;
}

export function oneMinuteReplayDiagnostics({ quotes, present, signals, fromEpoch,
  secondsPerTick, delayTicks, profitOnWin = 0.9 }) {
  const ticksPerMinute = 60 / secondsPerTick;
  if (!Number.isInteger(ticksPerMinute) ||
      quotes.length !== present.length || quotes.length !== signals.length ||
      quotes.length % ticksPerMinute !== 0 || fromEpoch % 60 !== 0) {
    throw new Error("One-minute replay requires aligned complete tick slots.");
  }
  const minutes = [];
  for (let startIndex = 0; startIndex < quotes.length; startIndex += ticksPerMinute) {
    const replay = replayForwardHalf({ quotes, present, signals, fromEpoch,
      secondsPerTick, startIndex, endExclusive: startIndex + ticksPerMinute,
      delayTicks, durationTicks: 5 });
    const scored = scoreForwardCounts(replay.counts, profitOnWin);
    minutes.push({ fromEpoch: fromEpoch + startIndex * secondsPerTick,
      trades: scored.settledTrades, wins: scored.wins, losses: scored.losses,
      netProfitPerDollarStake: scored.netProfitPerDollarStake });
  }
  const active = minutes.filter((item) => item.trades > 0);
  return { delayTicks, profitOnWin, minutesTested: minutes.length,
    activeMinutes: active.length, zeroTradeMinutes: minutes.length - active.length,
    positiveMinutes: active.filter((item) => item.netProfitPerDollarStake > 0).length,
    negativeMinutes: active.filter((item) => item.netProfitPerDollarStake < 0).length,
    breakEvenMinutes: active.filter((item) => item.netProfitPerDollarStake === 0).length,
    totalTrades: active.reduce((sum, item) => sum + item.trades, 0),
    totalWins: active.reduce((sum, item) => sum + item.wins, 0),
    totalLosses: active.reduce((sum, item) => sum + item.losses, 0),
    netProfitPerDollarStake: active.reduce((sum, item) =>
      sum + item.netProfitPerDollarStake, 0),
    minutes };
}

export function evaluateShortlistCandidate({ protocol, spec, pages, catalog }) {
  const audit = auditShortlistPages(pages, spec, protocol);
  if (audit.state === "INCOMPLETE") {
    return { symbol: spec.symbol, methodId: spec.methodId,
      decision: "NO_TRADE_INCOMPLETE_ARCHIVE", audit, scenarios: [] };
  }
  const quotes = new Float64Array(audit.expectedTicks);
  const present = new Uint8Array(audit.expectedTicks);
  for (const page of pages) for (const [epoch, quote] of page.ticks) {
    const index = (epoch - protocol.fromEpoch) / spec.secondsPerTick;
    quotes[index] = quote;
    present[index] = 1;
  }
  const midpoint = quotes.length / 2;
  if (!Number.isInteger(midpoint)) throw new Error("Shortlist midpoint is not a tick boundary.");
  const group = additionalMethodGroups(catalog).find((item) =>
    item.ids.includes(spec.methodId));
  if (!group) throw new Error(`Frozen shortlist method missing from catalog: ${spec.methodId}`);
  const signals = buildVariantGroupSignals(quotes, present, [midpoint], group)[spec.methodId];
  const scenarios = [];
  const oneMinuteRuns = [];
  const failures = [];
  for (const delayTicks of protocol.evaluation.entryDelayTicks) {
    const base = { quotes, present, signals, fromEpoch: protocol.fromEpoch,
      secondsPerTick: spec.secondsPerTick, delayTicks, durationTicks: 5 };
    const first = replayForwardHalf({ ...base, startIndex: 0, endExclusive: midpoint });
    const second = replayForwardHalf({ ...base, startIndex: midpoint,
      endExclusive: quotes.length });
    const hourly = combineHourly(first.hourly, second.hourly);
    oneMinuteRuns.push(oneMinuteReplayDiagnostics({ quotes, present, signals,
      fromEpoch: protocol.fromEpoch, secondsPerTick: spec.secondsPerTick,
      delayTicks, profitOnWin: 0.9 }));
    const bootstrap = hourlyBootstrapLowerBound(hourly, protocol.fromEpoch,
      protocol.toEpochExclusive, { profitOnWin: 0.9, repetitions: 2000,
        confidence: 0.95, seed: 47_311 + delayTicks });
    for (const profitOnWin of protocol.evaluation.winProfitPerDollarStake) {
      const row = { delayTicks, profitOnWin,
        first: scoreForwardCounts(first.counts, profitOnWin),
        second: scoreForwardCounts(second.counts, profitOnWin),
        ...(profitOnWin === 0.9 ? { hourlyBootstrap95: bootstrap } : {}) };
      scenarios.push(row);
      if (profitOnWin === protocol.evaluation.stressWinProfitPerDollarStake) {
        if (row.first.settledTrades < 100 || row.second.settledTrades < 100) {
          failures.push(`delay ${delayTicks}: fewer than 100 trades per half`);
        }
        if (row.first.netProfitPerDollarStake <= 0 ||
            row.second.netProfitPerDollarStake <= 0) {
          failures.push(`delay ${delayTicks}: non-positive half at +0.90 win`);
        }
        if (bootstrap.lowerBound <= 0) {
          failures.push(`delay ${delayTicks}: 95% hourly bootstrap lower bound not positive`);
        }
      }
    }
  }
  return { symbol: spec.symbol, methodId: spec.methodId, audit,
    scenarios, oneMinuteRuns, failures,
    decision: failures.length ? "NO_TRADE_HISTORICAL_CHECK_FAILED" :
      "HISTORICAL_CHECK_PASSED_PROSPECTIVE_AND_PARITY_STILL_REQUIRED" };
}

export async function evaluateShortlistHistory({ projectRoot }) {
  const protocol = await loadShortlistProtocol(projectRoot);
  const studyRoot = studyRootFor(projectRoot);
  try {
    await access(path.join(studyRoot, "collector.lock"));
    throw new Error("Shortlist collector remains active; evaluation is locked.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const status = JSON.parse(await readFile(path.join(studyRoot, "status.json"), "utf8"));
  const collectionBytes = await readFile(path.join(studyRoot, "collection-report.json"));
  const collection = JSON.parse(collectionBytes);
  if (!(["COMPLETED", "INCOMPLETE"].includes(status.state) &&
      status.state === collection.state && status.mode === "public-data-only" &&
      status.endpoint === PUBLIC_ENDPOINT && collection.endpoint === PUBLIC_ENDPOINT &&
      status.protocolSha256 === SHORTLIST_PROTOCOL_SHA256 &&
      collection.protocolSha256 === SHORTLIST_PROTOCOL_SHA256 &&
      collection.fromEpoch === protocol.fromEpoch &&
      collection.toEpochExclusive === protocol.toEpochExclusive &&
      collection.symbols.length === 3)) {
    throw new Error("Shortlist collection completion or provenance check failed.");
  }
  const catalogBytes = await readFile(path.join(projectRoot, "data", "market",
    "method-screen-500-additional-v1.json"));
  if (sha256(catalogBytes) !==
      "9f45a2b73a4880edac58f9f89e565b01f81819dbd533378285752c177ec9d24a") {
    throw new Error("Frozen 500-method catalog checksum changed.");
  }
  const catalog = JSON.parse(catalogBytes);
  const candidates = [];
  for (const spec of protocol.candidates) {
    const pages = await readShortlistPages(projectRoot, spec, protocol);
    const candidate = evaluateShortlistCandidate({ protocol, spec, pages, catalog });
    const collected = collection.symbols.find((item) => item.symbol === spec.symbol);
    if (!collected || JSON.stringify(candidate.audit) !== JSON.stringify(collected)) {
      throw new Error(`Shortlist archive audit changed: ${spec.symbol}`);
    }
    candidates.push(candidate);
  }
  const report = { kind: "public-shortlist-historical-evaluation",
    generatedAtUtc: new Date().toISOString(), protocolSha256: SHORTLIST_PROTOCOL_SHA256,
    collectionReportSha256: sha256(collectionBytes), endpoint: PUBLIC_ENDPOINT,
    fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive,
    candidateCount: 3, candidates,
    decision: candidates.some((item) =>
      item.decision === "HISTORICAL_CHECK_PASSED_PROSPECTIVE_AND_PARITY_STILL_REQUIRED") ?
      "PROVISIONAL_HISTORICAL_SUPPORT_ONLY" : "NO_TRADE_NO_HISTORICAL_CHECK_PASS",
    evidenceLevel: protocol.evidenceLevel,
    indicativePublicPayoutProbeOnly: true, observedExecutablePayouts: false,
    botBuilderParity: "UNVERIFIED", botBuilderRunPermission: false,
    demoOrderPermission: false, realOrderPermission: false,
    limitations: ["Candidates were selected after screening 550 variants across 13 symbols on another day.",
      "This is retrospective, not a live prospective test, and cannot establish profit.",
      "The one-minute replays are descriptive, reset open-contract state each minute, and were not a selection criterion.",
      "Public proposal snapshots are not executable account-specific quotes.",
      "Bot Builder implementation and decision/entry timing parity have not been verified."] };
  const reportPath = path.join(projectRoot, "data", "reports",
    `shortlist-historical-check-${protocol.fromEpoch}-${protocol.toEpochExclusive}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
