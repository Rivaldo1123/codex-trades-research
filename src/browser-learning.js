import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function wilsonInterval(wins, observations, z = 1.959963984540054) {
  if (observations === 0) return { lower: null, upper: null };
  const rate = wins / observations;
  const z2 = z * z;
  const denominator = 1 + z2 / observations;
  const center = (rate + z2 / (2 * observations)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (rate * (1 - rate)) / observations + z2 / (4 * observations ** 2),
    );
  return { lower: center - margin, upper: center + margin };
}

function streaks(transactions) {
  let currentType = null;
  let current = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const transaction of transactions) {
    const type = transaction.profit > 0 ? "win" : "loss";
    current = type === currentType ? current + 1 : 1;
    currentType = type;
    if (type === "win") maxWins = Math.max(maxWins, current);
    else maxLosses = Math.max(maxLosses, current);
  }
  return { maxConsecutiveLosses: maxLosses, maxConsecutiveWins: maxWins };
}

export function createBrowserLearningReport(runs) {
  const transactions = runs
    .flatMap((run) => run.transactions ?? [])
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const wins = transactions.filter((transaction) => transaction.profit > 0).length;
  const losses = transactions.filter((transaction) => transaction.profit <= 0).length;
  const netProfit = transactions.reduce(
    (sum, transaction) => sum + transaction.profit,
    0,
  );
  const totalStake = transactions.reduce(
    (sum, transaction) => sum + transaction.buyPrice,
    0,
  );
  const grossWins = transactions
    .filter((transaction) => transaction.profit > 0)
    .reduce((sum, transaction) => sum + transaction.profit, 0);
  const grossLosses = -transactions
    .filter((transaction) => transaction.profit <= 0)
    .reduce((sum, transaction) => sum + transaction.profit, 0);
  const observations = transactions.length;
  const winRate = observations === 0 ? null : wins / observations;
  const targetWinRate = 0.8;
  const variants = {};
  for (const run of runs) {
    const variantId = run.variantId ?? "unclassified";
    variants[variantId] ??= { runs: 0, transactions: [] };
    variants[variantId].runs += 1;
    variants[variantId].transactions.push(...(run.transactions ?? []));
  }

  const summarize = (items) => {
    const variantWins = items.filter((transaction) => transaction.profit > 0).length;
    const variantLosses = items.length - variantWins;
    const variantGrossWins = items
      .filter((transaction) => transaction.profit > 0)
      .reduce((sum, transaction) => sum + transaction.profit, 0);
    const variantGrossLosses = -items
      .filter((transaction) => transaction.profit <= 0)
      .reduce((sum, transaction) => sum + transaction.profit, 0);
    const variantNetProfit = variantGrossWins - variantGrossLosses;
    return {
      averageProfitPerTrade:
        items.length === 0 ? null : variantNetProfit / items.length,
      grossLosses: variantGrossLosses,
      grossWins: variantGrossWins,
      losses: variantLosses,
      netProfit: variantNetProfit,
      observations: items.length,
      profitFactor:
        variantGrossLosses === 0 ? null : variantGrossWins / variantGrossLosses,
      winRate: items.length === 0 ? null : variantWins / items.length,
      winRateWilson95: wilsonInterval(variantWins, items.length),
      wins: variantWins,
      ...streaks(
        [...items].sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        ),
      ),
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    branch: "Deriv Bot Builder demo observations",
    disclaimer:
      "Demo observations are not a guarantee of future results. Strategy changes require fresh out-of-sample validation.",
    runs: runs.length,
    byVariant: Object.fromEntries(
      Object.entries(variants)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([variantId, variant]) => [
          variantId,
          { runs: variant.runs, ...summarize(variant.transactions) },
        ]),
    ),
    totals: {
      averageProfitPerTrade: observations === 0 ? null : netProfit / observations,
      grossLosses,
      grossWins,
      losses,
      netProfit,
      observations,
      profitFactor: grossLosses === 0 ? null : grossWins / grossLosses,
      totalStake,
      winRate,
      winRateWilson95: wilsonInterval(wins, observations),
      wins,
      ...streaks(transactions),
    },
    target: {
      achieved: winRate !== null && winRate >= targetWinRate,
      targetWinRate,
      warning:
        "An 80% win-rate target cannot be engineered or promised; optimizing until historical data says 80% would create selection bias.",
    },
  };
}

async function main() {
  const runsDirectory = path.join(projectRoot, "data", "browser-bot", "runs");
  const files = (await readdir(runsDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const runs = [];
  for (const file of files) {
    runs.push(JSON.parse(await readFile(path.join(runsDirectory, file), "utf8")));
  }
  const report = createBrowserLearningReport(runs);
  const reportPath = path.join(projectRoot, "data", "browser-bot", "learning-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, ...report.totals }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
