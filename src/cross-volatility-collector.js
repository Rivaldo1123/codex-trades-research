import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { renameStatusFileWithRetry } from "./atomic-status.js";
import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

export const CROSS_VOLATILITY_PROTOCOL_SHA256 =
  "976ef6ba70977919c1fb20d718ac5119b364b413cc5e801fa7d0d7b1ef396b75";
export const CROSS_VOLATILITY_V2_PROTOCOL_SHA256 =
  "083aee8825a4cd851fe9b4da853f32bb48935ed2e490274c6d63259ddb6a1b98";
const STUDY_DIRECTORY = "cross-volatility-24h-v1";
const STUDY_DIRECTORY_V2 = "cross-volatility-24h-v2-gap-aware";
const PAGE_PATTERN = /^page-(\d+)-(\d+)-([0-9a-f]{64})\.json\.gz$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicStatus(statusPath, status) {
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`);
  await renameStatusFileWithRetry(temporary, statusPath);
}

export function validateCrossVolatilityProtocol(protocol) {
  if (protocol.kind !== "public-only-cross-volatility-24h-study" ||
      protocol.endpoint !== PUBLIC_ENDPOINT || protocol.mode !== "public-data-only" ||
      protocol.fromEpoch !== 1_791_338_400 || protocol.toEpochExclusive !== 1_791_424_800 ||
      !Array.isArray(protocol.symbols) || protocol.symbols.length !== 13 ||
      protocol.collection.pageSize !== 1000 ||
      protocol.collection.minimumInterRequestMs < 1500 ||
      protocol.botBuilderRunPermission !== false || protocol.demoOrderPermission !== false ||
      protocol.realOrderPermission !== false) {
    throw new Error("Cross-volatility public-only protocol safety lock changed.");
  }
  const names = new Set();
  for (const { symbol, name, secondsPerTick, expectedTicks } of protocol.symbols) {
    if (!/^(R_(10|25|50|75|100)|1HZ(10|15|25|30|50|75|90|100)V)$/.test(symbol) ||
        names.has(symbol) || !/^Volatility /.test(name) ||
        ![1, 2].includes(secondsPerTick) ||
        expectedTicks !== (protocol.toEpochExclusive - protocol.fromEpoch) / secondsPerTick ||
        protocol.fromEpoch % secondsPerTick !== 0 ||
        protocol.toEpochExclusive % secondsPerTick !== 0) {
      throw new Error(`Cross-volatility symbol grid changed: ${symbol}.`);
    }
    names.add(symbol);
  }
  return protocol;
}

export async function loadCrossVolatilityProtocol(projectRoot) {
  const protocolPath = path.join(projectRoot, "data", "market",
    "cross-volatility-24h-v1.json");
  const bytes = await readFile(protocolPath);
  if (sha256(bytes) !== CROSS_VOLATILITY_PROTOCOL_SHA256) {
    throw new Error("Frozen cross-volatility protocol checksum changed.");
  }
  return validateCrossVolatilityProtocol(JSON.parse(bytes));
}

export async function loadCrossVolatilityProtocolV2(projectRoot) {
  const bytes = await readFile(path.join(projectRoot, "data", "market",
    "cross-volatility-24h-v2-gap-aware.json"));
  if (sha256(bytes) !== CROSS_VOLATILITY_V2_PROTOCOL_SHA256) {
    throw new Error("Frozen gap-aware cross-volatility protocol checksum changed.");
  }
  const update = JSON.parse(bytes);
  const base = await loadCrossVolatilityProtocol(projectRoot);
  if (update.kind !== "public-only-cross-volatility-24h-gap-aware-study" ||
      update.version !== 2 || update.baseProtocolSha256 !== CROSS_VOLATILITY_PROTOCOL_SHA256 ||
      update.endpoint !== PUBLIC_ENDPOINT || update.mode !== "public-data-only" ||
      update.fromEpoch !== base.fromEpoch ||
      update.toEpochExclusive !== base.toEpochExclusive ||
      update.collection.minimumCoverageRatePerSymbol !== 0.999 ||
      update.collection.pageSize !== 1000 ||
      update.collection.minimumInterRequestMs < 1500 ||
      update.botBuilderRunPermission !== false ||
      update.demoOrderPermission !== false || update.realOrderPermission !== false) {
    throw new Error("Gap-aware cross-volatility safety protocol changed.");
  }
  return { ...base, ...update,
    symbols: base.symbols, collection: { ...base.collection, ...update.collection },
    evaluation: { ...base.evaluation, ...update.evaluation } };
}

function validatePage(page, symbolSpec, protocol,
  { protocolSha256 = CROSS_VOLATILITY_PROTOCOL_SHA256, allowGaps = false } = {}) {
  if (page.kind !== "public-cross-volatility-tick-page" ||
      page.protocolSha256 !== protocolSha256 ||
      page.endpoint !== PUBLIC_ENDPOINT || page.symbol !== symbolSpec.symbol ||
      page.fromEpoch !== protocol.fromEpoch ||
      page.toEpochExclusive !== protocol.toEpochExclusive ||
      !Array.isArray(page.ticks) || page.ticks.length < 1 || page.ticks.length > 1000) {
    throw new Error(`Invalid stored public tick page for ${symbolSpec.symbol}.`);
  }
  let priorEpoch = null;
  for (const tick of page.ticks) {
    if (!Array.isArray(tick) || tick.length !== 2 ||
        !Number.isSafeInteger(tick[0]) || !Number.isFinite(tick[1]) ||
        tick[0] < protocol.fromEpoch || tick[0] >= protocol.toEpochExclusive ||
        (tick[0] - protocol.fromEpoch) % symbolSpec.secondsPerTick !== 0 ||
        (priorEpoch !== null && (tick[0] <= priorEpoch ||
          (!allowGaps && tick[0] - priorEpoch !== symbolSpec.secondsPerTick)))) {
      throw new Error(`Gap, conflict or invalid quote within ${symbolSpec.symbol} page.`);
    }
    priorEpoch = tick[0];
  }
  return { firstEpoch: page.ticks[0][0], lastEpoch: page.ticks.at(-1)[0],
    rows: page.ticks.length };
}

export async function readStoredCrossVolatilityPages(studyRoot, symbolSpec, protocol,
  options = {}) {
  const directory = path.join(studyRoot, symbolSpec.symbol);
  await mkdir(directory, { recursive: true });
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json.gz"));
  const pages = [];
  for (const file of files) {
    const match = PAGE_PATTERN.exec(file);
    if (!match) throw new Error(`Unexpected cross-volatility archive file: ${file}.`);
    const bytes = await readFile(path.join(directory, file));
    if (sha256(bytes) !== match[3]) {
      throw new Error(`Cross-volatility page checksum failed: ${file}.`);
    }
    const page = JSON.parse(gunzipSync(bytes));
    const meta = validatePage(page, symbolSpec, protocol, options);
    if (meta.firstEpoch !== Number(match[1]) || meta.lastEpoch !== Number(match[2])) {
      throw new Error(`Cross-volatility page name does not match rows: ${file}.`);
    }
    pages.push({ file, ...meta, ticks: page.ticks });
  }
  pages.sort((a, b) => a.firstEpoch - b.firstEpoch);
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i].firstEpoch <= pages[i - 1].lastEpoch ||
        (!options.allowGaps && pages[i].firstEpoch !==
          pages[i - 1].lastEpoch + symbolSpec.secondsPerTick)) {
      throw new Error(`Cross-volatility archive gap or overlap for ${symbolSpec.symbol}.`);
    }
  }
  if (pages.length && !options.allowGaps && pages.at(-1).lastEpoch !==
      protocol.toEpochExclusive - symbolSpec.secondsPerTick) {
    throw new Error(`Cross-volatility archive end boundary changed for ${symbolSpec.symbol}.`);
  }
  return pages;
}

async function savePage(studyRoot, symbolSpec, protocol, ticks, options = {}) {
  const page = { kind: "public-cross-volatility-tick-page",
    protocolSha256: options.protocolSha256 ?? CROSS_VOLATILITY_PROTOCOL_SHA256,
    endpoint: PUBLIC_ENDPOINT,
    symbol: symbolSpec.symbol, fromEpoch: protocol.fromEpoch,
    toEpochExclusive: protocol.toEpochExclusive,
    ticks: ticks.map(({ epoch, quote }) => [epoch, quote]) };
  const meta = validatePage(page, symbolSpec, protocol, options);
  const bytes = gzipSync(Buffer.from(JSON.stringify(page)));
  const digest = sha256(bytes);
  const file = `page-${meta.firstEpoch}-${meta.lastEpoch}-${digest}.json.gz`;
  await writeFile(path.join(studyRoot, symbolSpec.symbol, file), bytes, { flag: "wx" });
  return { file, ...meta };
}

function auditCompletePages(pages, symbolSpec, protocol,
  { minimumCoverageRate = 1 } = {}) {
  if (!pages.length || (minimumCoverageRate === 1 &&
      (pages[0].firstEpoch !== protocol.fromEpoch ||
        pages.at(-1).lastEpoch !== protocol.toEpochExclusive - symbolSpec.secondsPerTick))) {
    throw new Error(`Incomplete fixed UTC tick window for ${symbolSpec.symbol}.`);
  }
  const rowCount = pages.reduce((sum, page) => sum + page.rows, 0);
  if (rowCount > symbolSpec.expectedTicks ||
      (minimumCoverageRate === 1 && rowCount !== symbolSpec.expectedTicks)) {
    throw new Error(`Expected ${symbolSpec.expectedTicks} ticks for ${symbolSpec.symbol}, got ${rowCount}.`);
  }
  const hasher = createHash("sha256");
  const missingRanges = [];
  let expectedEpoch = protocol.fromEpoch;
  for (const page of pages) {
    for (const [epoch, quote] of page.ticks) {
      if (epoch < expectedEpoch || (epoch - expectedEpoch) % symbolSpec.secondsPerTick !== 0) {
        throw new Error(`Invalid cross-volatility row ordering for ${symbolSpec.symbol}.`);
      }
      if (epoch > expectedEpoch) {
        missingRanges.push({ fromEpoch: expectedEpoch, toEpochExclusive: epoch,
          missingTicks: (epoch - expectedEpoch) / symbolSpec.secondsPerTick });
      }
      hasher.update(`${epoch},${quote}\n`);
      expectedEpoch = epoch + symbolSpec.secondsPerTick;
    }
  }
  if (expectedEpoch < protocol.toEpochExclusive) {
    missingRanges.push({ fromEpoch: expectedEpoch,
      toEpochExclusive: protocol.toEpochExclusive,
      missingTicks: (protocol.toEpochExclusive - expectedEpoch) / symbolSpec.secondsPerTick });
  }
  const coverageRate = rowCount / symbolSpec.expectedTicks;
  return { symbol: symbolSpec.symbol, name: symbolSpec.name,
    secondsPerTick: symbolSpec.secondsPerTick,
    expectedTicks: symbolSpec.expectedTicks, observedTicks: rowCount,
    missingTicks: symbolSpec.expectedTicks - rowCount, missingRanges,
    coverageRate,
    state: coverageRate >= minimumCoverageRate ?
      missingRanges.length ? "PASS_WITH_GAPS" : "COMPLETE" : "INCOMPLETE",
    firstEpoch: pages[0].firstEpoch, lastEpoch: pages.at(-1).lastEpoch,
    pageCount: pages.length, rowSha256: hasher.digest("hex") };
}

export async function runCrossVolatilityCollection({ projectRoot,
  onProgress = () => {}, clientFactory = () => new DerivPublicClient(),
  studyVersion = 1 }) {
  if (![1, 2].includes(studyVersion)) throw new Error("Unknown cross-volatility study version.");
  const isGapAware = studyVersion === 2;
  const protocol = isGapAware ? await loadCrossVolatilityProtocolV2(projectRoot) :
    await loadCrossVolatilityProtocol(projectRoot);
  const protocolSha256 = isGapAware ? CROSS_VOLATILITY_V2_PROTOCOL_SHA256 :
    CROSS_VOLATILITY_PROTOCOL_SHA256;
  const pageOptions = { protocolSha256, allowGaps: isGapAware };
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== "1HZ100V") throw new Error("Existing public-only safety lock changed.");
  const studyRoot = path.join(projectRoot, "data", "market",
    isGapAware ? STUDY_DIRECTORY_V2 : STUDY_DIRECTORY);
  await mkdir(studyRoot, { recursive: true });
  const statusPath = path.join(studyRoot, "status.json");
  const reportPath = path.join(studyRoot, "collection-report.json");
  const status = { kind: "public-cross-volatility-collection-status",
    protocolSha256, endpoint: PUBLIC_ENDPOINT,
    mode: "public-data-only", pid: process.pid, state: "STARTING",
    currentSymbol: null, symbolsCompleted: 0, totalSymbols: protocol.symbols.length,
    pagesStored: 0, rowsStored: 0, lastError: null, retryAtUtc: null,
    startedAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString() };
  const update = async (fields) => {
    Object.assign(status, fields, { updatedAtUtc: new Date().toISOString() });
    await atomicStatus(statusPath, status);
    onProgress(status);
  };
  await update({});
  let client = clientFactory();
  const connectWithRetry = async () => {
    for (let attempt = 1; attempt <= protocol.collection.maximumReconnectRetries; attempt += 1) {
      try {
        await client.connect();
        return;
      } catch (error) {
        if (attempt === protocol.collection.maximumReconnectRetries) throw error;
        const delayMs = Math.min(5_000 * 2 ** (attempt - 1), 60_000);
        await update({ state: "BACKING_OFF", lastError: String(error),
          retryAtUtc: new Date(Date.now() + delayMs).toISOString() });
        client.close();
        await wait(delayMs);
        client = clientFactory();
      }
    }
  };
  try {
    await connectWithRetry();
    const available = (await client.getActiveSymbols())
      .filter(({ name }) => /^Volatility /i.test(name ?? ""))
      .map(({ symbol }) => symbol).sort();
    const frozen = protocol.symbols.map(({ symbol }) => symbol).sort();
    if (JSON.stringify(available) !== JSON.stringify(frozen)) {
      throw new Error("Active public Volatility Index symbol set changed from the frozen 13.");
    }
    const complete = [];
    for (const symbolSpec of protocol.symbols) {
      await update({ state: "RUNNING", currentSymbol: symbolSpec.symbol,
        lastError: null, retryAtUtc: null });
      let pages = await readStoredCrossVolatilityPages(studyRoot, symbolSpec,
        protocol, pageOptions);
      let cursor = pages.length ? pages[0].firstEpoch - 1 : protocol.toEpochExclusive - 1;
      let rateLimitRetries = 0, reconnectRetries = 0;
      while (cursor >= protocol.fromEpoch) {
        let ticks;
        try {
          ticks = await client.getTicksHistory(symbolSpec.symbol,
            { count: protocol.collection.pageSize, start: protocol.fromEpoch, end: cursor });
        } catch (error) {
          const message = String(error);
          const isRateLimit = /RateLimit|rate limit/i.test(message);
          if (isRateLimit) rateLimitRetries += 1;
          else reconnectRetries += 1;
          if ((isRateLimit && rateLimitRetries >
              protocol.collection.maximumConsecutiveRateLimitRetries) ||
              (!isRateLimit && reconnectRetries >
                protocol.collection.maximumReconnectRetries)) throw error;
          const retry = isRateLimit ? rateLimitRetries : reconnectRetries;
          const delayMs = isRateLimit ? Math.min(5_000 * 2 ** Math.min(retry - 1, 6), 300_000) :
            Math.min(5_000 * 2 ** (retry - 1), 60_000);
          await update({ state: "BACKING_OFF", lastError: message,
            retryAtUtc: new Date(Date.now() + delayMs).toISOString() });
          client.close();
          await wait(delayMs);
          client = clientFactory();
          await connectWithRetry();
          await update({ state: "RUNNING", retryAtUtc: null });
          continue;
        }
        rateLimitRetries = reconnectRetries = 0;
        if (!ticks.length) break;
        if (ticks.length > 1000 || ticks.at(-1).epoch > cursor ||
            (pages.length && (ticks.at(-1).epoch >= pages[0].firstEpoch ||
              (!isGapAware && ticks.at(-1).epoch !==
                pages[0].firstEpoch - symbolSpec.secondsPerTick)))) {
          throw new Error(`Unexpected public tick-history page boundary for ${symbolSpec.symbol}.`);
        }
        const saved = await savePage(studyRoot, symbolSpec, protocol, ticks, pageOptions);
        pages.unshift({ ...saved, ticks: ticks.map(({ epoch, quote }) => [epoch, quote]) });
        cursor = saved.firstEpoch - 1;
        await update({ state: "RUNNING", pagesStored: status.pagesStored + 1,
          rowsStored: status.rowsStored + saved.rows,
          lastPage: { symbol: symbolSpec.symbol, firstEpoch: saved.firstEpoch,
            lastEpoch: saved.lastEpoch, rows: saved.rows },
          lastError: null, retryAtUtc: null });
        await wait(protocol.collection.minimumInterRequestMs);
      }
      const summary = auditCompletePages(pages, symbolSpec, protocol,
        { minimumCoverageRate: isGapAware ?
          protocol.collection.minimumCoverageRatePerSymbol : 1 });
      complete.push(summary);
      await update({ state: "RUNNING", symbolsCompleted: complete.length,
        currentSymbol: symbolSpec.symbol, lastCompletedSymbol: summary });
    }
    const report = { kind: "public-cross-volatility-collection-report",
      state: complete.every((item) => item.state !== "INCOMPLETE") ? "COMPLETED" :
        "INCOMPLETE", generatedAtUtc: new Date().toISOString(),
      protocolSha256, endpoint: PUBLIC_ENDPOINT,
      fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive,
      symbolCount: complete.length,
      totalExpectedTicks: complete.reduce((sum, item) => sum + item.expectedTicks, 0),
      totalObservedTicks: complete.reduce((sum, item) => sum + item.observedTicks, 0),
      symbols: complete,
      botBuilderRunPermission: false, demoOrderPermission: false, realOrderPermission: false };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await update({ state: report.state, currentSymbol: null, reportPath });
    return { report, reportPath, statusPath };
  } catch (error) {
    await update({ state: "FAILED", lastError: String(error), retryAtUtc: null });
    throw error;
  } finally {
    client.close();
  }
}
