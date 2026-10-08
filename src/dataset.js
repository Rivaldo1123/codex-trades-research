import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function numeric(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function createCompressedCsv(filePath, header) {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(filePath, { flags: "wx" });
  const completed = new Promise((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
    gzip.once("error", reject);
  });
  gzip.pipe(output);
  gzip.write(`${header.join(",")}\n`);
  return { completed, gzip };
}

async function writeLine(stream, values) {
  if (!stream.write(`${values.join(",")}\n`)) {
    await once(stream, "drain");
  }
}

function buildPrefixes(ticks) {
  const price = new Float64Array(ticks.length + 1);
  const squaredReturns = new Float64Array(ticks.length + 1);
  for (let index = 0; index < ticks.length; index += 1) {
    const quote = ticks[index].quote;
    price[index + 1] = price[index] + quote;
    let squared = 0;
    if (index > 0 && ticks[index - 1].quote !== 0) {
      const change = quote / ticks[index - 1].quote - 1;
      squared = change * change;
    }
    squaredReturns[index + 1] = squaredReturns[index] + squared;
  }
  return { price, squaredReturns };
}

export function createPurgedSplitPlan(
  tickCount,
  { maxFeatureWindow, maxHorizon },
) {
  const firstRowIndex = maxFeatureWindow;
  const endExclusive = tickCount - maxHorizon;
  const usable = Math.max(0, endExclusive - firstRowIndex);
  const trainBoundary = firstRowIndex + Math.floor(usable * 0.7);
  const validationBoundary = firstRowIndex + Math.floor(usable * 0.85);
  return {
    endExclusive,
    firstRowIndex,
    maxHorizon,
    trainBoundary,
    validationBoundary,
  };
}

export function splitForTickIndex(index, plan) {
  if (index < plan.trainBoundary - plan.maxHorizon) return "train";
  if (index < plan.trainBoundary) return null;
  if (index < plan.validationBoundary - plan.maxHorizon) return "validation";
  if (index < plan.validationBoundary) return null;
  if (index < plan.endExclusive) return "test";
  return null;
}

export async function writeTrainingDataset({
  config,
  projectRoot,
  ticks,
}) {
  const windows = [...new Set(config.featureWindowsTicks)].sort((a, b) => a - b);
  const horizons = [...new Set(config.horizonsTicks)].sort((a, b) => a - b);
  const maxFeatureWindow = Math.max(...windows);
  const maxHorizon = Math.max(...horizons);
  if (ticks.length < maxFeatureWindow + maxHorizon + 100) {
    throw new Error(
      `Need at least ${maxFeatureWindow + maxHorizon + 100} ticks to build a dataset; found ${ticks.length}.`,
    );
  }

  const plan = createPurgedSplitPlan(ticks.length, {
    maxFeatureWindow,
    maxHorizon,
  });
  const featureColumns = windows.flatMap((window) => [
    `return_${window}`,
    `price_vs_sma_${window}`,
    `volatility_${window}`,
  ]);
  const labelColumns = horizons.flatMap((horizon) => [
    `future_return_${horizon}`,
    `direction_${horizon}`,
  ]);
  const columns = ["epoch", "quote", ...featureColumns, ...labelColumns];
  const directory = path.join(
    projectRoot,
    "data",
    "datasets",
    config.symbol,
    safeTimestamp(),
  );
  await mkdir(directory, { recursive: true });
  const writers = Object.fromEntries(
    ["train", "validation", "test"].map((split) => [
      split,
      createCompressedCsv(path.join(directory, `${split}.csv.gz`), columns),
    ]),
  );
  const rowCounts = { train: 0, validation: 0, test: 0, purged: 0 };
  const prefixes = buildPrefixes(ticks);

  try {
    for (let index = plan.firstRowIndex; index < plan.endExclusive; index += 1) {
      const split = splitForTickIndex(index, plan);
      if (!split) {
        rowCounts.purged += 1;
        continue;
      }
      const current = ticks[index].quote;
      const values = [ticks[index].epoch, numeric(current)];
      for (const window of windows) {
        const prior = ticks[index - window].quote;
        const average =
          (prefixes.price[index + 1] - prefixes.price[index + 1 - window]) /
          window;
        const squaredSum =
          prefixes.squaredReturns[index + 1] -
          prefixes.squaredReturns[index + 1 - window];
        values.push(
          numeric(current / prior - 1),
          numeric(current / average - 1),
          numeric(Math.sqrt(squaredSum / window)),
        );
      }
      for (const horizon of horizons) {
        const futureReturn = ticks[index + horizon].quote / current - 1;
        values.push(numeric(futureReturn), Math.sign(futureReturn));
      }
      await writeLine(writers[split].gzip, values);
      rowCounts[split] += 1;
    }
  } finally {
    for (const writer of Object.values(writers)) {
      writer.gzip.end();
    }
    await Promise.all(Object.values(writers).map((writer) => writer.completed));
  }

  const metadata = {
    createdAt: new Date().toISOString(),
    files: {
      test: "test.csv.gz",
      train: "train.csv.gz",
      validation: "validation.csv.gz",
    },
    firstEpoch: ticks[plan.firstRowIndex].epoch,
    horizonsTicks: horizons,
    inputTicks: ticks.length,
    lastEpoch: ticks[plan.endExclusive - 1].epoch,
    leakageControls: {
      featureDirection: "Features use only the current tick and earlier ticks.",
      split: "Chronological 70/15/15 train/validation/test.",
      purgeTicks: maxHorizon,
    },
    maxFeatureWindow,
    rowCounts,
    symbol: config.symbol,
    columns,
  };
  await writeFile(
    path.join(directory, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  return { directory, metadata };
}
