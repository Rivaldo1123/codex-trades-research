import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  getAccountId,
  getDemoWebSocketUrl,
  getOptionsAccounts,
  selectDemoAccount,
  validateDemoConfig,
} from "./deriv-demo.js";
import {
  appendTradeEvent,
  assertTradeJournalAccount,
  createLearningReport,
  readTradeEvents,
  writeLearningReport,
} from "./demo-learning.js";
import { settlementJournalEvent, strictFiniteNumber, strictPositiveInteger } from "./demo-contract-validation.js";
import { verifyDemoDeploymentEligibility } from "./demo-deployment-gate.js";
import { demoStrategyIdentity, hashDemoAccountId } from "./demo-identities.js";
import { assessDemoRisk } from "./demo-risk.js";
import { reconcileUnresolvedDemoTrades } from "./demo-trade-state.js";
import { DerivDemoClient, directionToContractType } from "./demo-ws-client.js";
import { buildSignals } from "./research.js";

export function hashDemoStrategyConfig(config) {
  return demoStrategyIdentity(config);
}

export function buildDemoDecision(candles, strategy, { now = null } = {}) {
  if (!Array.isArray(candles) || candles.some((candle, index) =>
    !Number.isSafeInteger(candle?.epoch) || !Number.isFinite(candle?.close) ||
    (index > 0 && candle.epoch <= candles[index - 1].epoch))) {
    throw new Error("Demo decision candles must be finite and strictly chronological.");
  }
  let usableCandles = now && Number.isInteger(strategy.granularitySeconds)
    ? candles.filter((candle) =>
        candle.epoch + strategy.granularitySeconds <= Math.floor(now.getTime() / 1_000))
    : candles;
  if (Number.isInteger(strategy.granularitySeconds)) {
    let contiguousStart = 0;
    for (let index = 1; index < usableCandles.length; index += 1) {
      if (usableCandles[index].epoch - usableCandles[index - 1].epoch !==
          strategy.granularitySeconds) {
        contiguousStart = index;
      }
    }
    usableCandles = usableCandles.slice(contiguousStart);
    if (now && usableCandles.length > 0) {
      const lastClosedAt = usableCandles.at(-1).epoch + strategy.granularitySeconds;
      if (Math.floor(now.getTime() / 1_000) - lastClosedAt >=
          strategy.granularitySeconds) {
        throw new Error("The latest completed demo candle is stale.");
      }
    }
  }
  if (usableCandles.length < strategy.slowWindow) {
    throw new Error("Not enough contiguous completed candles for the configured demo strategy.");
  }
  const latest = buildSignals(
    usableCandles,
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
    const decision = buildDemoDecision(candles, config.strategy, { now: new Date() });
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

export async function tradeDemoOnce({
  config,
  credentials,
  projectRoot,
  runtime = {},
}) {
  validateDemoConfig(config);
  const strategyHash = hashDemoStrategyConfig(config);
  const deployment = await verifyDemoDeploymentEligibility({
    config,
    projectRoot,
    strategyHash,
  });
  const releaseLock = await acquireRunLock(projectRoot);
  const journalPath = path.join(projectRoot, config.learning.journalPath);
  const reportPath = path.join(projectRoot, config.learning.reportPath);
  let client;
  try {
    const clock = runtime.now ?? (() => new Date());
    const appendJournal = runtime.appendTradeEvent ?? appendTradeEvent;
    const readJournal = runtime.readTradeEvents ?? readTradeEvents;
    const writeReport = runtime.writeLearningReport ?? writeLearningReport;
    const connection = await (runtime.connectDemo ?? connectDemo)(config, credentials);
    client = connection.client;
    const accountFingerprint = hashDemoAccountId(connection.id);

    let events = await readJournal(journalPath);
    assertTradeJournalAccount(events, accountFingerprint);
    const reconciliation = await reconcileUnresolvedDemoTrades({
      accountFingerprint,
      client,
      events,
      appendEvent: (event) => appendJournal(journalPath, event),
    });
    events = [...events, ...reconciliation.appended];
    if (reconciliation.blockers.length > 0) {
      throw new Error(
        "Demo execution blocked by unresolved broker outcome: " +
          reconciliation.blockers.map((item) => item.reason).join(" "),
      );
    }

    const [candles, balanceBefore, portfolio] = await Promise.all([
      client.getCandles(config.symbol, {
        count: config.strategy.candleCount,
        granularity: config.strategy.granularitySeconds,
      }),
      client.getBalance(),
      client.getPortfolio(),
    ]);
    const decisionAt = clock();
    const decision = buildDemoDecision(candles, config.strategy, { now: decisionAt });
    if (!deployment.allowedContractTypes.includes(decision.contractType)) {
      throw new Error("Deployment gate does not authorize the signalled contract type.");
    }
    const proposal = await client.getProposal({
      currency: config.currency,
      direction: decision.direction,
      duration: config.strategy.contractDuration,
      durationUnit: config.strategy.contractDurationUnit,
      stake: config.risk.stakeDemoUsd,
      symbol: config.symbol,
    });
    if (proposal.contractType !== decision.contractType ||
        proposal.symbol !== config.symbol ||
        proposal.currency !== config.currency ||
        proposal.duration !== config.strategy.contractDuration ||
        proposal.durationUnit !== config.strategy.contractDurationUnit) {
      throw new Error("Broker proposal terms differ from the qualified candidate terms.");
    }
    const askPrice = strictFiniteNumber(proposal.askPrice, "Proposal ask price", { positive: true });
    const payout = strictFiniteNumber(proposal.payout, "Proposal gross payout", { positive: true });
    if (askPrice > config.risk.stakeDemoUsd) {
      throw new Error("Safety lock: proposal price exceeds the configured demo stake.");
    }
    const winNetPerUnitRisk = (payout - askPrice) / askPrice;
    if (winNetPerUnitRisk < deployment.executionAssumptions.minimumWinNetPerUnitRisk) {
      throw new Error("Executable proposal economics fail the candidate's frozen minimum payout condition.");
    }
    const spotTime = strictPositiveInteger(proposal.spotTime, "Proposal spot time");
    const proposalCheckedAt = clock();
    const proposalAgeSeconds = Math.floor(proposalCheckedAt.getTime() / 1_000) - spotTime;
    if (proposalAgeSeconds < -2 ||
        proposalAgeSeconds > deployment.executionAssumptions.maxProposalAgeSeconds) {
      throw new Error("Executable proposal is outside the candidate's quote-freshness limit.");
    }
    const risk = assessDemoRisk({
      config,
      events,
      nextMaximumLoss: askPrice,
      now: decisionAt,
      openContracts: portfolio,
    });
    if (!risk.allowed) {
      throw new Error(`Demo risk gate blocked the trade: ${risk.reasons.join(" ")}`);
    }

    const tradeId = (runtime.randomUUID ?? randomUUID)();
    const startedAt = clock().toISOString();
    const pending = {
      ...decision,
      accountFingerprint,
      candidateId: deployment.candidateId,
      currency: config.currency,
      duration: config.strategy.contractDuration,
      durationUnit: config.strategy.contractDurationUnit,
      eventAt: startedAt,
      executorSourceSha256: deployment.executorSourceSha256,
      maximumLoss: askPrice,
      stage: "pending",
      stake: config.risk.stakeDemoUsd,
      startedAt,
      strategyHash,
      symbol: config.symbol,
      tradeId,
    };
    await appendJournal(journalPath, pending);

    let purchase;
    try {
      purchase = await client.buyProposal(proposal.id, askPrice, {
        candidateId: deployment.candidateId,
        config,
        executorSourceSha256: deployment.executorSourceSha256,
        projectRoot,
        strategyHash,
      });
      purchase = {
        ...purchase,
        buyPrice: strictFiniteNumber(purchase.buyPrice, "Confirmed demo buy price", { positive: true }),
        contractId: strictPositiveInteger(purchase.contractId, "Confirmed demo contract ID"),
      };
      if (purchase.buyPrice > askPrice) {
        throw new Error("Confirmed demo buy price exceeds the authorized proposal price.");
      }
      if (purchase.purchaseTime !== null && purchase.purchaseTime !== undefined) {
        purchase.purchaseTime = strictPositiveInteger(
          purchase.purchaseTime,
          "Confirmed demo purchase time",
        );
        const startedEpoch = Math.floor(Date.parse(startedAt) / 1_000);
        const currentEpoch = Math.floor(clock().getTime() / 1_000);
        if (purchase.purchaseTime < startedEpoch - 5 || purchase.purchaseTime > currentEpoch + 5) {
          throw new Error("Confirmed demo purchase time is incompatible with the purchase intent.");
        }
      }
    } catch (error) {
      await appendJournal(journalPath, {
        accountFingerprint,
        eventAt: clock().toISOString(),
        failure: error.message,
        maximumLoss: askPrice,
        stage: "uncertain",
        strategyHash,
        tradeId,
        uncertainty: "Purchase request may have reached the broker; never retry blindly.",
      });
      throw new Error(
        "Demo purchase outcome is uncertain and must be reconciled from broker records before another run.",
        { cause: error },
      );
    }
    const purchased = {
      ...pending,
      accountFingerprint,
      buyPrice: purchase.buyPrice,
      contractId: purchase.contractId,
      eventAt: clock().toISOString(),
      maximumLoss: purchase.buyPrice,
      reconciliationStatus: "broker_purchase_confirmed",
      brokerPayout: purchase.payout ?? null,
      purchaseTime: purchase.purchaseTime ?? null,
      shortcode: purchase.shortcode ?? null,
      stage: "reconciled",
      strategyHash,
      tradeId,
      transactionId: purchase.transactionId ?? null,
    };
    try {
      await appendJournal(journalPath, purchased);
    } catch (error) {
      throw new Error(
        "Demo purchase was confirmed but could not be journalled; the durable pending intent must be reconciled before any retry.",
        { cause: error },
      );
    }

    let settled;
    try {
      settled = await client.waitForSettlement(purchase.contractId, {
        timeoutMs: config.strategy.settlementTimeoutSeconds * 1_000,
      });
      settled = settlementJournalEvent(purchased, settled, clock());
    } catch (error) {
      await appendJournal(journalPath, {
        accountFingerprint,
        buyPrice: purchase.buyPrice,
        contractId: purchase.contractId,
        eventAt: clock().toISOString(),
        failure: error.message,
        maximumLoss: purchase.buyPrice,
        stage: "uncertain",
        strategyHash,
        tradeId,
        uncertainty: "Known contract outcome could not be established.",
      });
      throw new Error(
        "Demo contract outcome is uncertain and must be reconciled before another run.",
        { cause: error },
      );
    }
    const balanceAfter = await client.getBalance();
    await appendJournal(journalPath, {
      ...settled,
      balanceAfter: balanceAfter.amount,
    });

    const updatedEvents = await readJournal(journalPath);
    const learning = createLearningReport(updatedEvents);
    await writeReport(reportPath, learning);

    return {
      accountIdSuffix: connection.id.slice(-4),
      balanceAfter: balanceAfter.amount,
      balanceBefore: balanceBefore.amount,
      contractIdSuffix: String(purchase.contractId).slice(-6),
      direction: decision.direction,
      profit: settled.profit,
      riskBeforeTrade: risk,
      signalSeparationBps: decision.separationBps,
      status: settled.status,
      symbol: config.symbol,
      tradeId,
    };
  } finally {
    client?.close();
    await releaseLock();
  }
}
