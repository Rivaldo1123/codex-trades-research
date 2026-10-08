import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { CROSS_VOLATILITY_PROTOCOL_SHA256, CROSS_VOLATILITY_V2_PROTOCOL_SHA256,
  loadCrossVolatilityProtocol, loadCrossVolatilityProtocolV2,
  readStoredCrossVolatilityPages,
  validateCrossVolatilityProtocol } from "../src/cross-volatility-collector.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cross-volatility protocol pins all 13 public-only symbols and exact cadence", async () => {
  const protocol = await loadCrossVolatilityProtocol(root);
  assert.equal(protocol.symbols.length, 13);
  assert.equal(protocol.symbols.reduce((total, symbol) => total + symbol.expectedTicks, 0),
    907_200);
  const changed = structuredClone(protocol);
  changed.endpoint = "wss://api.derivws.com/trading/v1/options/ws/real";
  assert.throws(() => validateCrossVolatilityProtocol(changed), /safety lock/);
  const duplicate = structuredClone(protocol);
  duplicate.symbols[1].symbol = duplicate.symbols[0].symbol;
  assert.throws(() => validateCrossVolatilityProtocol(duplicate), /symbol grid/);
  const bytes = await readFile(path.join(root, "data", "market",
    "cross-volatility-24h-v1.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    CROSS_VOLATILITY_PROTOCOL_SHA256);
});

test("gap-aware v2 keeps the same thirteen symbols and labels source omissions", async () => {
  const protocol = await loadCrossVolatilityProtocolV2(root);
  assert.equal(protocol.symbols.length, 13);
  assert.equal(protocol.collection.minimumCoverageRatePerSymbol, 0.999);
  assert.equal(protocol.botBuilderRunPermission, false);
  const bytes = await readFile(path.join(root, "data", "market",
    "cross-volatility-24h-v2-gap-aware.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    CROSS_VOLATILITY_V2_PROTOCOL_SHA256);
});

test("stored cross-volatility pages are checksum checked and exact-cadence checked", async () => {
  const protocol = await loadCrossVolatilityProtocol(root);
  const symbol = protocol.symbols[0];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cross-volatility-test-"));
  try {
    const directory = path.join(temporary, symbol.symbol);
    await mkdir(directory);
    const ticks = [[protocol.toEpochExclusive - 4, 100],
      [protocol.toEpochExclusive - 2, 101]];
    const page = { kind: "public-cross-volatility-tick-page",
      protocolSha256: CROSS_VOLATILITY_PROTOCOL_SHA256,
      endpoint: protocol.endpoint, symbol: symbol.symbol,
      fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive, ticks };
    const bytes = gzipSync(Buffer.from(JSON.stringify(page)));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const filename = `page-${ticks[0][0]}-${ticks[1][0]}-${digest}.json.gz`;
    const file = path.join(directory, filename);
    await writeFile(file, bytes);
    const loaded = await readStoredCrossVolatilityPages(temporary, symbol, protocol);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].rows, 2);
    await writeFile(file, Buffer.from("damaged"));
    await assert.rejects(readStoredCrossVolatilityPages(temporary, symbol, protocol), /checksum failed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("gap-aware page loader keeps genuine missing ticks absent", async () => {
  const protocol = await loadCrossVolatilityProtocolV2(root);
  const symbol = protocol.symbols[0];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cross-volatility-gaps-test-"));
  try {
    const directory = path.join(temporary, symbol.symbol);
    await mkdir(directory);
    const ticks = [[protocol.toEpochExclusive - 8, 100],
      [protocol.toEpochExclusive - 2, 101]];
    const page = { kind: "public-cross-volatility-tick-page",
      protocolSha256: CROSS_VOLATILITY_V2_PROTOCOL_SHA256,
      endpoint: protocol.endpoint, symbol: symbol.symbol,
      fromEpoch: protocol.fromEpoch, toEpochExclusive: protocol.toEpochExclusive, ticks };
    const bytes = gzipSync(Buffer.from(JSON.stringify(page)));
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(directory,
      `page-${ticks[0][0]}-${ticks[1][0]}-${digest}.json.gz`), bytes);
    const loaded = await readStoredCrossVolatilityPages(temporary, symbol, protocol,
      { protocolSha256: CROSS_VOLATILITY_V2_PROTOCOL_SHA256, allowGaps: true });
    assert.equal(loaded[0].rows, 2);
    await assert.rejects(readStoredCrossVolatilityPages(temporary, symbol, protocol,
      { protocolSha256: CROSS_VOLATILITY_V2_PROTOCOL_SHA256 }), /Gap, conflict/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
