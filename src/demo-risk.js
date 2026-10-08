import { groupTrades } from "./demo-learning.js";

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function assessDemoRisk({ config, events, openContracts, now = new Date() }) {
  const reasons = [];
  const trades = groupTrades(events);
  const today = utcDay(now);
  const todaysTrades = trades.filter(
    (trade) => trade.startedAt && utcDay(trade.startedAt) === today,
  );
  const settledToday = todaysTrades.filter(
    (trade) => trade.stage === "settled" && Number.isFinite(trade.profit),
  );
  const netProfitToday = settledToday.reduce(
    (sum, trade) => sum + trade.profit,
    0,
  );
  const dailyLoss = Math.max(0, -netProfitToday);

  if (!config.executionEnabled) {
    reasons.push("Demo execution is disabled in config.demo.json.");
  }
  if (openContracts.length >= config.risk.maxOpenContracts) {
    reasons.push("The demo account already has the maximum open contracts.");
  }
  if (todaysTrades.length >= config.risk.maxTradesPerDay) {
    reasons.push("The demo daily trade limit has been reached.");
  }
  if (dailyLoss >= config.risk.maxDailyLossDemoUsd) {
    reasons.push("The demo daily loss limit has been reached.");
  }

  const lastTrade = todaysTrades
    .filter((trade) => trade.startedAt)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  let cooldownRemainingSeconds = 0;
  if (lastTrade) {
    const cooldownMs = config.risk.cooldownMinutes * 60_000;
    const remainingMs =
      Date.parse(lastTrade.startedAt) + cooldownMs - now.getTime();
    cooldownRemainingSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
    if (cooldownRemainingSeconds > 0) {
      reasons.push("The demo cooldown has not elapsed.");
    }
  }

  return {
    allowed: reasons.length === 0,
    cooldownRemainingSeconds,
    dailyLoss,
    netProfitToday,
    openContracts: openContracts.length,
    reasons,
    tradesToday: todaysTrades.length,
  };
}
