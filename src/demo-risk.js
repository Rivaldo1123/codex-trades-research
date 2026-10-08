import { groupTrades } from "./demo-learning.js";

export const DAILY_LIMIT_TIMEZONE = "UTC";
const UNRESOLVED_STAGES = new Set(["intent", "pending", "bought", "uncertain"]);

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function isUnresolvedDemoTrade(trade) {
  if (!trade || trade.stage === "settled") return false;
  if (
    trade.stage === "reconciled" &&
    ["not_purchased", "closed_without_profit"].includes(trade.reconciliationStatus)
  ) {
    return false;
  }
  return (
    UNRESOLVED_STAGES.has(trade.stage) ||
    trade.stage === "reconciled" ||
    Boolean(trade.contractId)
  );
}

function relevantForTradeLimits(trade) {
  if (!trade?.startedAt) return false;
  return !(
    trade.stage === "reconciled" &&
    trade.reconciliationStatus === "not_purchased"
  );
}

function maximumLossFor(trade, fallback) {
  for (const value of [trade.maximumLoss, trade.buyPrice, trade.stake]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function pendingExposure(trades, openContracts, fallback) {
  const representedContracts = new Set();
  let exposure = 0;
  for (const trade of trades.filter(isUnresolvedDemoTrade)) {
    if (trade.contractId !== undefined && trade.contractId !== null) {
      representedContracts.add(String(trade.contractId));
    }
    exposure += maximumLossFor(trade, fallback);
  }
  for (const contract of openContracts) {
    const id = contract.contract_id ?? contract.contractId;
    if (id !== undefined && representedContracts.has(String(id))) continue;
    exposure += maximumLossFor(
      {
        maximumLoss: contract.buy_price ?? contract.buyPrice,
      },
      fallback,
    );
  }
  return exposure;
}

export function assessDemoRisk({
  config,
  events,
  openContracts,
  now = new Date(),
  nextMaximumLoss = config?.risk?.stakeDemoUsd,
}) {
  const reasons = [];
  const trades = groupTrades(events);
  const today = utcDay(now);
  const todaysTrades = trades.filter(
    (trade) => relevantForTradeLimits(trade) && utcDay(trade.startedAt) === today,
  );
  const settledToday = todaysTrades.filter(
    (trade) => trade.stage === "settled" && Number.isFinite(trade.profit),
  );
  const netProfitToday = settledToday.reduce(
    (sum, trade) => sum + trade.profit,
    0,
  );
  const dailyLoss = Math.max(0, -netProfitToday);
  const unresolvedTrades = trades.filter(isUnresolvedDemoTrade);
  const reservedPendingLoss = pendingExposure(
    trades,
    openContracts,
    config.risk.stakeDemoUsd,
  );
  const parsedNextMaximumLoss = Number(nextMaximumLoss);
  if (!Number.isFinite(parsedNextMaximumLoss) || parsedNextMaximumLoss <= 0) {
    throw new Error("The next contract maximum loss must be a positive number.");
  }
  const projectedDailyLoss =
    dailyLoss + reservedPendingLoss + parsedNextMaximumLoss;

  if (!config.executionEnabled) {
    reasons.push("Demo execution is disabled in config.demo.json.");
  }
  if (openContracts.length >= config.risk.maxOpenContracts) {
    reasons.push("The demo account already has the maximum open contracts.");
  }
  if (unresolvedTrades.length > 0) {
    reasons.push(
      "An earlier purchase outcome is pending or uncertain and must be reconciled before another run.",
    );
  }
  if (todaysTrades.length >= config.risk.maxTradesPerDay) {
    reasons.push("The demo daily trade limit has been reached.");
  }
  if (dailyLoss >= config.risk.maxDailyLossDemoUsd) {
    reasons.push("The demo daily loss limit has been reached.");
  } else if (projectedDailyLoss > config.risk.maxDailyLossDemoUsd) {
    reasons.push(
      "The settled loss, pending exposure, and next contract maximum loss would exceed the demo daily loss limit.",
    );
  }

  const lastTrade = trades
    .filter(relevantForTradeLimits)
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
    dailyLimitTimezone: DAILY_LIMIT_TIMEZONE,
    dailyLoss,
    netProfitToday,
    nextMaximumLoss: parsedNextMaximumLoss,
    openContracts: openContracts.length,
    projectedDailyLoss,
    reasons,
    reservedPendingLoss,
    tradesToday: todaysTrades.length,
    unresolvedTrades: unresolvedTrades.length,
  };
}
