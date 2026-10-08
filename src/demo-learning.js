import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readTradeEvents(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON in demo journal line ${index + 1}.`);
      }
    });
}

export async function appendTradeEvent(filePath, event) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

export function groupTrades(events) {
  const trades = new Map();
  for (const event of events) {
    if (typeof event.tradeId !== "string") {
      continue;
    }
    const current = trades.get(event.tradeId) ?? { tradeId: event.tradeId };
    trades.set(event.tradeId, { ...current, ...event });
  }
  return [...trades.values()];
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function createLearningReport(events) {
  const allTrades = groupTrades(events);
  const settled = allTrades.filter(
    (trade) => trade.stage === "settled" && Number.isFinite(trade.profit),
  );
  const wins = settled.filter((trade) => trade.profit > 0);
  const losses = settled.filter((trade) => trade.profit < 0);
  const pushes = settled.filter((trade) => trade.profit === 0);
  const profits = settled.map((trade) => trade.profit);

  const byDirection = Object.fromEntries(
    ["up", "down"].map((direction) => {
      const trades = settled.filter((trade) => trade.direction === direction);
      const directionWins = trades.filter((trade) => trade.profit > 0).length;
      return [
        direction,
        {
          averageProfit: mean(trades.map((trade) => trade.profit)),
          settledTrades: trades.length,
          winRate: trades.length === 0 ? null : directionWins / trades.length,
        },
      ];
    }),
  );

  return {
    automaticParameterChanges: false,
    generatedAt: new Date().toISOString(),
    methodology:
      "Forward demo outcomes only. Results do not imply real-money profitability.",
    totals: {
      averageProfit: mean(profits),
      losses: losses.length,
      netProfit: profits.reduce((sum, value) => sum + value, 0),
      pushes: pushes.length,
      settledTrades: settled.length,
      winRate: settled.length === 0 ? null : wins.length / settled.length,
      wins: wins.length,
    },
    byDirection,
  };
}

export async function writeLearningReport(filePath, report) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
