import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  getAccountId,
  getDemoWebSocketUrl,
  getOptionsAccounts,
  selectDemoAccount,
} from "./deriv-demo.js";
import {
  appendTradeEvent,
  createLearningReport,
  readTradeEvents,
  writeLearningReport,
} from "./demo-learning.js";
import { assessDemoRisk } from "./demo-risk.js";
import { DerivDemoClient, directionToContractType } from "./demo-ws-client.js";
import { buildSignals } from "./research.js";

export function buildDemoDecision(candles, strategy) {
  if (candles.length < strategy.slowWindow) {
    throw new Error("Not enough candles for the configured demo strategy.");
  }
  const latest = buildSignals(
    candles,
    strategy.fastWindow,
    strategy.slowWindow,
  ).at(-1);
  if (!latest || latest.signal === "wait") {
    throw new Error("The demo strategy does not have a tradable signal yet.");
  }

  return {
    candleEpoch: latest.epoch,
    close: latest.close,
    contractType: directionToContractType(latest.signal),
    direction: latest.signal,
    fast: latest.fast,
    separationBps:
      ((latest.fast - latest.slow) / latest.close) * 10_000,
    slow: latest.slow,
  };
}

async function acquireRunLock(projectRoot) {
  const lockPath = path.join(projectRoot, "data", "demo", "bot.lock");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(lockPath), { recursive: true }),
  );
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Another demo bot run appears active. Remove data/demo/bot.lock only after confirming no bot process is running.",
      );
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`, "utf8");
  return async () => {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  };
}

async function connectDemo(config, credentials) {
  const accounts = await getOptionsAccounts(credentials);
  const account = selectDemoAccount(accounts, config.accountId);
  const id = getAccountId(account);
  const endpoint = await getDemoWebSocketUrl(credentials, id);
  const client = new DerivDemoClient(endpoint);
  await client.connect();
  return { client, id };
}

export async function createDemoPlan({ config, credentials }) {
  const { client, id } = await connectDemo(config, credentials);
  try {
    const candles = await client.getCandles(config.symbol, {
      count: config.strategy.candleCount,
      granularity: config.strategy.granularitySeconds,
    });
    const decision = buildDemoDecision(candles, config.strategy);
    const balance = await client.getBalance();
    const portfolio = await client.getPortfolio();
    return {
      accountIdSuffix: id.slice(-4),
      balance,
      decision,
      openContracts: portfolio.length,
      stakeDemoUsd: config.risk.stakeDemoUsd,
      symbol: config.symbol,
    };
  } finally {
    client.close();
  }
}

export async function tradeDemoOnce({ config, credentials, projectRoot }) {
  const releaseLock = await acquireRunLock(projectRoot);
  const journalPath = path.join(projectRoot, config.learning.journalPath);
  const reportPath = path.join(projectRoot, config.learning.reportPath);
  let client;
  try {
    const connection = await connectDemo(config, credentials);
    client = connection.client;

    const [candles, balanceBefore, portfolio, events] = await Promise.all([
      client.getCandles(config.symbol, {
        count: config.strategy.candleCount,
        granularity: config.strategy.granularitySeconds,
      }),
      client.getBalance(),
      client.getPortfolio(),
      readTradeEvents(journalPath),
    ]);
    const decision = buildDemoDecision(candles, config.strategy);
    const risk = assessDemoRisk({ config, events, openContracts: portfolio });
    if (!risk.allowed) {
      throw new Error(`Demo risk gate blocked the trade: ${risk.reasons.join(" ")}`);
    }

    const proposal = await client.getProposal({
      currency: config.currency,
      direction: decision.direction,
      duration: config.strategy.contractDuration,
      durationUnit: config.strategy.contractDurationUnit,
      stake: config.risk.stakeDemoUsd,
      symbol: config.symbol,
    });
    if (proposal.askPrice > config.risk.stakeDemoUsd) {
      throw new Error("Safety lock: proposal price exceeds the configured demo stake.");
    }

    const tradeId = randomUUID();
    const startedAt = new Date().toISOString();
    await appendTradeEvent(journalPath, {
      ...decision,
      eventAt: startedAt,
      stage: "intent",
      stake: config.risk.stakeDemoUsd,
      startedAt,
      symbol: config.symbol,
      tradeId,
    });

    const purchase = await client.buyProposal(proposal.id, proposal.askPrice);
    await appendTradeEvent(journalPath, {
      buyPrice: purchase.buyPrice,
      contractId: purchase.contractId,
      eventAt: new Date().toISOString(),
      stage: "bought",
      tradeId,
    });

    const settled = await client.waitForSettlement(purchase.contractId, {
      timeoutMs: config.strategy.settlementTimeoutSeconds * 1_000,
    });
    const balanceAfter = await client.getBalance();
    const profit = Number(settled.profit);
    if (!Number.isFinite(profit)) {
      throw new Error("Deriv did not return numeric demo profit after settlement.");
    }

    const closedAt = new Date().toISOString();
    await appendTradeEvent(journalPath, {
      balanceAfter: balanceAfter.amount,
      closedAt,
      eventAt: closedAt,
      exitSpot: Number(settled.exit_spot ?? settled.exit_tick),
      profit,
      stage: "settled",
      status: String(settled.status ?? (profit > 0 ? "won" : "lost")),
      tradeId,
    });

    const updatedEvents = await readTradeEvents(journalPath);
    const learning = createLearningReport(updatedEvents);
    await writeLearningReport(reportPath, learning);

    return {
      accountIdSuffix: connection.id.slice(-4),
      balanceAfter: balanceAfter.amount,
      balanceBefore: balanceBefore.amount,
      contractIdSuffix: String(purchase.contractId).slice(-6),
      direction: decision.direction,
      profit,
      riskBeforeTrade: risk,
      signalSeparationBps: decision.separationBps,
      status: String(settled.status ?? "settled"),
      symbol: config.symbol,
      tradeId,
    };
  } finally {
    client?.close();
    await releaseLock();
  }
}
