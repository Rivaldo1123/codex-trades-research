import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DerivPublicClient } from "./deriv-public.js";
import { createResearchReport } from "./research.js";
import { retryRateLimited } from "./retry.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function loadConfig() {
  const raw = await readFile(path.join(projectRoot, "config.json"), "utf8");
  const config = JSON.parse(raw);
  if (config.mode !== "research-only") {
    throw new Error("Safety lock: config mode must remain research-only.");
  }
  return config;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

async function listSymbols(client) {
  const symbols = await client.getActiveSymbols();
  const synthetic = symbols.filter(
    (item) =>
      item.market === "synthetic_index" ||
      item.market === "derived" ||
      item.type?.includes("synthetic"),
  );
  const output = synthetic.length > 0 ? synthetic : symbols;
  console.table(output.slice(0, 50));
  console.log(`Received ${symbols.length} active symbols from Deriv.`);
}

async function createSnapshot(client, config) {
  const candles = await retryRateLimited(
    () =>
      client.getCandles(config.symbol, {
        count: config.candleCount,
        granularity: config.granularitySeconds,
      }),
    {
      onRetry: ({ attempt, delayMs }) => {
        console.warn(
          `Deriv rate limit reached. Retry ${attempt} in ${delayMs / 1000} seconds.`,
        );
      },
    },
  );
  const report = {
    mode: config.mode,
    source: "Deriv public market data",
    symbol: config.symbol,
    ...createResearchReport(candles, config),
  };

  const reportsDirectory = path.join(projectRoot, "data", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = path.join(
    reportsDirectory,
    `${config.symbol}-${safeTimestamp()}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Research report saved to ${reportPath}`);
  console.log(
    JSON.stringify(
      {
        disclaimer: report.disclaimer,
        latestSignal: report.latestSignal.signal,
        testing: report.testing,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const command = process.argv[2] ?? "snapshot";
  const config = await loadConfig();
  const client = new DerivPublicClient(config.endpoint);

  try {
    await client.connect();
    if (command === "symbols") {
      await listSymbols(client);
      return;
    }
    if (command === "snapshot") {
      await createSnapshot(client, config);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
